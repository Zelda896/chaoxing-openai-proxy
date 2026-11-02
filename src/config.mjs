// Runtime configuration for the proxy. Everything is env-driven so a fresh clone can be deployed
// locally without editing source.
import { loadEnvFile } from './env.mjs';

// Optional .env support; real environment variables always take precedence.
loadEnvFile();

const env = process.env;
const splitList = (value) =>
  (value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

export const config = {
  port: Number(env.PORT ?? 8686),
  host: env.HOST ?? '127.0.0.1',

  // Target tenant / robot (overridable so the proxy can serve other units).
  unitId: env.UNIT_ID ?? '21354',
  robotId: env.ROBOT_ID ?? 'dfda0d9629b34e0fa59a9b57834b8c56',

  upstreamBase: env.UPSTREAM_BASE ?? 'https://robot.chaoxing.com',
  upstreamWs: env.UPSTREAM_WS ?? 'wss://robot.chaoxing.com',

  // Header the SPA sends with every request; upstream tolerates a fixed value.
  feVersion: env.FE_VERSION ?? 'd2796afa2.26103019-production',
  userAgent:
    env.USER_AGENT ??
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',

  // Advertised model id(s) and the answer budget for a single question.
  modelName: env.MODEL_NAME ?? 'chaoxing-ai-librarian',
  // Extra aliases so clients that hardcode a well-known name (gpt-4o-mini, …) still resolve.
  modelAliases: splitList(env.MODEL_ALIASES),
  answerTimeoutMs: Number(env.ANSWER_TIMEOUT_MS ?? 120_000),
  answerIdleMs: Number(env.ANSWER_IDLE_MS ?? 3_000),

  // API keys accepted as `Authorization: Bearer <key>`. Empty means "no auth" (loopback-only use).
  apiKeys: splitList(env.API_KEYS),

  // Serve the bundled browser chat UI. Turn off for a pure API deployment.
  serveUi: env.SERVE_UI !== '0',

  // Hosts reachable through the generic /__host/<host>/<path> asset proxy.
  assetHosts: splitList(env.ASSET_HOSTS),
};

// Agent tool sandbox settings live here too so every entry point sees the same values.
export const agentConfig = {
  root: env.AGENT_ROOT ?? process.cwd(),
  allowExec: env.AGENT_ALLOW_EXEC !== '0',
  allowPrivate: env.AGENT_ALLOW_PRIVATE === '1',
  maxSteps: Number(env.AGENT_MAX_STEPS ?? 6),
  stepTimeoutMs: Number(env.AGENT_STEP_TIMEOUT_MS ?? 30_000),
  maxToolCalls: Number(env.AGENT_MAX_TOOL_CALLS ?? 20),
};

export function upstreamHeaders(extra = {}) {
  return {
    'User-Agent': config.userAgent,
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    lang: 'zh-CN',
    fe_version: config.feVersion,
    Referer: `${config.upstreamBase}/coze/mobile?unitId=${config.unitId}&robotId=${config.robotId}`,
    ...extra,
  };
}

/** Verify an incoming request against the configured API keys. */
export function authorize(req) {
  if (!config.apiKeys.length) return true;
  const header = req.headers.authorization ?? '';
  const provided = header.replace(/^Bearer\s+/i, '').trim() || req.headers['x-api-key'] || '';
  return config.apiKeys.includes(String(provided));
}
