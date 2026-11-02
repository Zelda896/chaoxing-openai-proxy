// Generic HTTP + WebSocket reverse proxy with header hygiene.
import WebSocket, { WebSocketServer } from 'ws';
import { config, upstreamHeaders } from './config.mjs';

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

// Headers we never relay to the browser: they would block embedding or pin the origin.
const STRIPPED_RESPONSE_HEADERS = new Set([
  'content-security-policy',
  'content-security-policy-report-only',
  'x-frame-options',
  'content-encoding',
  'content-length',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'strict-transport-security',
  'alt-svc',
  'report-to',
  'nel',
]);

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
  'access-control-allow-headers': 'content-type,authorization,fe_version,lang,x-requested-with',
  'access-control-max-age': '600',
};

function rewriteSetCookie(value, origin) {
  return value
    .split(/,(?=\s*[A-Za-z0-9_.-]+=)/)
    .map((cookie) =>
      cookie
        .replace(/;\s*Domain=[^;]*/gi, '')
        .replace(/;\s*Secure/gi, '')
        .replace(/;\s*SameSite=None/gi, '; SameSite=Lax'),
    )
    .map((cookie) => cookie.replace(/;\s*Path=[^;]*/i, '; Path=/'))
    .join(', ');
}

/**
 * Proxy one HTTP request to `targetBase + path`.
 * `extraCookie` lets the caller inject a visitor identity for stateless API use.
 */
export async function proxyHttp(req, res, { targetBase, path, extraCookie, rewriteLocation = true }) {
  const headers = upstreamHeaders();
  for (const [key, value] of Object.entries(req.headers)) {
    if (HOP_BY_HOP.has(key) || key === 'host' || key === 'cookie' || key === 'content-length') continue;
    if (key.startsWith('sec-')) continue;
    headers[key] = value;
  }
  const cookie = [req.headers.cookie, extraCookie].filter(Boolean).join('; ');
  if (cookie) headers.cookie = cookie;

  let upstreamResponse;
  try {
    upstreamResponse = await fetch(targetBase + path, {
      method: req.method,
      headers,
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : req,
      duplex: 'half',
      redirect: 'manual',
      signal: AbortSignal.timeout(60_000),
    });
  } catch (error) {
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'application/json', ...CORS });
    }
    res.end(JSON.stringify({ error: 'upstream_unreachable', detail: String(error?.message ?? error), path }));
    return;
  }

  const outHeaders = { ...CORS, 'x-proxied-by': 'chaoxing-coze-proxy' };
  for (const [key, value] of upstreamResponse.headers) {
    if (STRIPPED_RESPONSE_HEADERS.has(key)) continue;
    if (key === 'set-cookie') continue;
    if (key === 'location' && rewriteLocation && value.startsWith(targetBase)) {
      outHeaders.location = value.slice(targetBase.length) || '/';
      continue;
    }
    outHeaders[key] = value;
  }
  const setCookie = upstreamResponse.headers.getSetCookie?.() ?? [];
  if (setCookie.length) {
    outHeaders['set-cookie'] = setCookie.map((c) => rewriteSetCookie(c, req.headers.host));
  }

  res.writeHead(upstreamResponse.status, outHeaders);
  if (req.method === 'HEAD' || !upstreamResponse.body) {
    res.end();
    return;
  }
  const reader = upstreamResponse.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
  } catch {
    // Client went away; nothing else to do.
  }
  res.end();
}

/** Proxy a browser WebSocket upgrade to the upstream chat socket. */
export function attachWebSocketProxy(server) {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (!url.pathname.startsWith('/v1/ws/')) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (client) => {
      const headers = upstreamHeaders({ Origin: config.upstreamBase });
      if (req.headers.cookie) headers.Cookie = req.headers.cookie;
      if (req.headers['user-agent']) headers['User-Agent'] = req.headers['user-agent'];

      const upstream = new WebSocket(config.upstreamWs + url.pathname + url.search, { headers });

      const closeBoth = (code = 1000, reason = '') => {
        try { client.close(code, reason); } catch {}
        try { upstream.close(); } catch {}
      };

      upstream.on('open', () => {
        client.on('message', (data, isBinary) => {
          if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary });
        });
        upstream.on('message', (data, isBinary) => {
          if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary });
        });
      });
      upstream.on('close', (code, reason) => closeBoth(code === 1006 ? 1011 : code, reason?.toString() ?? ''));
      upstream.on('error', () => closeBoth(1011, 'upstream error'));
      client.on('close', () => { try { upstream.close(); } catch {} });
      client.on('error', () => { try { upstream.close(); } catch {} });
    });
  });
}

/** `/__host/<host>/<path>` asset proxy for cross-origin static assets. */
export async function proxyHost(req, res, pathname) {
  const match = /^\/__host\/([^/]+)(\/.*)?$/.exec(pathname);
  if (!match) {
    res.writeHead(404, CORS).end('bad asset path');
    return;
  }
  const [, host, rest = '/'] = match;
  if (config.assetHosts.length && !config.assetHosts.includes(host)) {
    res.writeHead(403, CORS).end('host not allowed');
    return;
  }
  await proxyHttp(req, res, { targetBase: `https://${host}`, path: rest + (new URL(req.url, 'http://x').search ?? '') });
}

