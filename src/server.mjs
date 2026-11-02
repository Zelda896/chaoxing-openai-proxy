// HTTP server: OpenAI-compatible API, bundled chat UI, legacy SSE endpoint, and the transparent proxy.
import http from 'node:http';
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { authorize, config } from './config.mjs';
import { ask, createVisitor, connectVisitor } from './chaoxing.mjs';
import { ensureVisitor, setSession, sessionCount, updateConversation } from './sessions.mjs';
import { attachWebSocketProxy, proxyHost, proxyHttp } from './proxy.mjs';
import { handleChatCompletions, handleModelById, listAgentTools, listModels, openaiError } from './openai.mjs';
import { runAgent } from './agent.mjs';
import { tools as agentTools } from './tools.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UI_HTML = path.join(__dirname, '..', 'public', 'index.html');

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
  'access-control-allow-headers': 'content-type,authorization,x-api-key,fe_version,lang,x-agent-mode',
  'access-control-max-age': '600',
};

const PROXY_PREFIXES = ['/static/', '/sdk/', '/coze', '/richview', '/v1/', '/api/', '/robot-res/', '/res/'];
const LOCAL_PATHS = new Set([
  '/',
  '/index.html',
  '/healthz',
  '/api/chat',
  '/api/session',
  '/v1/models',
  '/v1/chat/completions',
  '/v1/agent/chat',
  '/v1/agent/tools',
]);

const readBody = (req) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });

function sendJson(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...CORS });
  res.end(JSON.stringify(payload));
}

function sessionIdFrom(req) {
  const cookie = req.headers.cookie ?? '';
  const match = /(?:^|;\s*)px_sid=([^;]+)/.exec(cookie);
  return match ? decodeURIComponent(match[1]) : null;
}

/** POST /api/chat — the small SSE protocol the bundled UI speaks. */
async function handleLocalChat(req, res) {
  const raw = await readBody(req);
  let body;
  try {
    body = JSON.parse(raw || '{}');
  } catch {
    sendJson(res, 400, { error: 'invalid_json' });
    return;
  }
  const message = String(body.message ?? '').trim();
  if (!message) {
    sendJson(res, 400, { error: 'message_required' });
    return;
  }

  let sessionId = body.sessionId ?? sessionIdFrom(req);
  if (!sessionId) sessionId = crypto.randomUUID();
  const visitor = await ensureVisitor(sessionId, req.headers.cookie);

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
    'set-cookie': `px_sid=${sessionId}; Path=/; HttpOnly; SameSite=Lax`,
    ...CORS,
  });
  const emit = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);

  const controller = new AbortController();
  req.on('close', () => controller.abort());

  emit('session', { sessionId, visitorId: visitor.visitorId, conversationId: visitor.conversationId });

  try {
    for await (const event of ask(visitor, message, { signal: controller.signal })) {
      if (event.type === 'meta') emit('meta', event);
      else if (event.type === 'status') emit('status', event);
      else if (event.type === 'delta') emit('delta', event);
      else if (event.type === 'link') emit('link', event);
      else if (event.type === 'done') {
        if (event.conversationId) updateConversation(sessionId, event.conversationId);
        emit('done', {
          text: event.text,
          finishReason: event.finishReason,
          elapsedMs: event.elapsedMs,
          conversationId: event.conversationId,
          error: event.error,
        });
      }
    }
  } catch (error) {
    emit('error', { message: String(error?.message ?? error) });
  }
  res.end();
}

/** POST /v1/agent/chat — SSE agent loop with real local tool execution. */
async function handleAgentChat(req, res, { authorize: authorizeRequest } = {}) {
  if (authorizeRequest && !authorizeRequest(req)) {
    return sendJson(res, 401, { error: 'unauthorized' });
  }

  const raw = await readBody(req);
  let body;
  try {
    body = JSON.parse(raw || '{}');
  } catch {
    sendJson(res, 400, { error: 'invalid_json' });
    return;
  }
  const message = String(body.message ?? '').trim();
  if (!message) {
    sendJson(res, 400, { error: 'message_required' });
    return;
  }

  const toolNames = Array.isArray(body.tools) ? body.tools.map(String) : undefined;
  const maxSteps = Math.min(Math.max(Number(body.maxSteps ?? body.maxRounds ?? 6), 1), 10);

  let sessionId = body.sessionId ?? sessionIdFrom(req);
  if (!sessionId) sessionId = crypto.randomUUID();
  const visitor = await ensureVisitor(sessionId, req.headers.cookie);

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
    'set-cookie': `px_sid=${sessionId}; Path=/; HttpOnly; SameSite=Lax`,
    ...CORS,
  });
  const emit = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);

  const controller = new AbortController();
  req.on('close', () => controller.abort());

  emit('session', {
    sessionId,
    visitorId: visitor.visitorId,
    conversationId: visitor.conversationId,
    tools: toolNames ?? agentTools.map((tool) => tool.name),
    maxSteps,
    mode: 'code',
  });

  try {
    for await (const event of runAgent(visitor, message, {
      maxSteps,
      toolNames,
      signal: controller.signal,
    })) {
      emit(event.type, event);
    }
  } catch (error) {
    emit('error', { message: String(error?.message ?? error) });
  }
  res.end();
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  const pathname = url.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS).end();
    return;
  }

  try {
    if ((pathname === '/' || pathname === '/index.html') && req.method === 'GET') {
      if (!config.serveUi) {
        return sendJson(res, 404, { error: 'ui_disabled' });
      }
      const html = fs.readFileSync(UI_HTML);
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'set-cookie': `px_sid=${sessionIdFrom(req) ?? crypto.randomUUID()}; Path=/; HttpOnly; SameSite=Lax`,
        ...CORS,
      });
      res.end(html);
      return;
    }

    if (pathname === '/healthz') {
      return sendJson(res, 200, {
        ok: true,
        upstream: config.upstreamBase,
        unitId: config.unitId,
        robotId: config.robotId,
        model: config.modelName,
        authRequired: config.apiKeys.length > 0,
        sessions: sessionCount(),
      });
    }

    // ---- OpenAI-compatible surface ----
    if (pathname === '/v1/models' && req.method === 'GET') {
      if (!authorize(req)) return openaiError(res, 401, 'Incorrect API key provided', 'authentication_error', 'invalid_api_key');
      return sendJson(res, 200, listModels());
    }

    if (pathname.startsWith('/v1/models/') && req.method === 'GET') {
      if (!authorize(req)) return openaiError(res, 401, 'Incorrect API key provided', 'authentication_error', 'invalid_api_key');
      return handleModelById(res, decodeURIComponent(pathname.slice('/v1/models/'.length)));
    }

    if (pathname === '/v1/chat/completions' && req.method === 'POST') {
      const raw = await readBody(req);
      let body;
      try {
        body = JSON.parse(raw || '{}');
      } catch {
        return openaiError(res, 400, 'Request body is not valid JSON');
      }
      await handleChatCompletions(req, res, body, { authorize });
      return;
    }

    if (pathname === '/v1/agent/tools' && req.method === 'GET') {
      if (!authorize(req)) return openaiError(res, 401, 'Incorrect API key provided', 'authentication_error', 'invalid_api_key');
      return sendJson(res, 200, listAgentTools());
    }

    if (pathname === '/v1/agent/chat' && req.method === 'POST') {
      await handleAgentChat(req, res, { authorize });
      return;
    }

    // ---- Legacy / UI endpoints ----
    if (pathname === '/api/session' && req.method === 'POST') {
      const id = crypto.randomUUID();
      const visitor = await createVisitor();
      await connectVisitor(visitor);
      setSession(id, visitor);
      return sendJson(res, 200, { sessionId: id, visitorId: visitor.visitorId, conversationId: visitor.conversationId });
    }

    if (pathname === '/api/chat' && req.method === 'POST') {
      await handleLocalChat(req, res);
      return;
    }

    // ---- Transparent proxy ----
    if (pathname.startsWith('/__host/')) {
      await proxyHost(req, res, pathname);
      return;
    }

    const isProxyPath = PROXY_PREFIXES.some((prefix) => pathname.startsWith(prefix));
    if (isProxyPath && !LOCAL_PATHS.has(pathname)) {
      await proxyHttp(req, res, { targetBase: config.upstreamBase, path: req.url });
      return;
    }

    sendJson(res, 404, { error: 'not_found', path: pathname });
  } catch (error) {
    if (!res.headersSent) sendJson(res, 500, { error: 'internal_error', detail: String(error?.message ?? error) });
    else res.end();
  }
});

attachWebSocketProxy(server);

server.listen(config.port, config.host, () => {
  const base = `http://${config.host}:${config.port}`;
  console.log(`chaoxing-openai-proxy listening on ${base}`);
  console.log(`  target unit=${config.unitId} robot=${config.robotId}`);
  console.log(`  model=${config.modelName}${config.modelAliases.length ? ` (aliases: ${config.modelAliases.join(', ')})` : ''}`);
  console.log(`  auth=${config.apiKeys.length ? `required (${config.apiKeys.length} key(s))` : 'disabled (loopback only!)'}`);
  console.log(`  OpenAI base URL  ${base}/v1`);
  if (config.serveUi) console.log(`  web UI           ${base}/`);
  console.log(`  proxied page     ${base}/coze/mobile?unitId=${config.unitId}&robotId=${config.robotId}`);
});
