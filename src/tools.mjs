// Locally executed agent tools. Each tool runs for real and returns text or JSON.
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { agentConfig } from './config.mjs';

const MAX_TEXT = 8_000;
const ROOT = path.resolve(agentConfig.root);
const ALLOW_EXEC = agentConfig.allowExec;
const ALLOW_PRIVATE = agentConfig.allowPrivate;

const clip = (text, limit = MAX_TEXT) =>
  text.length > limit ? `${text.slice(0, limit)}\n…（已截断，共 ${text.length} 字符）` : text;

function withinRoot(target) {
  const resolved = path.resolve(ROOT, target);
  const relative = path.relative(ROOT, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`路径越界：只能访问 ${ROOT} 之内的文件（收到 ${target}）`);
  }
  return resolved;
}

const PRIVATE_RANGES = [
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./,
  /^0\./,
  /^localhost$/i,
  /^\[?::1\]?$/,
];

function assertPublicHost(hostname) {
  if (ALLOW_PRIVATE) return;
  if (PRIVATE_RANGES.some((re) => re.test(hostname))) {
    throw new Error(`拒绝访问内网地址 ${hostname}（如确需访问，设置 AGENT_ALLOW_PRIVATE=1）`);
  }
}

export const tools = [
  {
    name: 'now',
    description: '获取当前时间（含时区与星期）。无参数。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async run() {
      const now = new Date();
      const iso = now.toISOString();
      const local = new Intl.DateTimeFormat('zh-CN', {
        timeZone: 'Asia/Shanghai',
        dateStyle: 'full',
        timeStyle: 'medium',
      }).format(now);
      return { iso, local, tz: 'Asia/Shanghai', epochMs: now.getTime() };
    },
  },
  {
    name: 'http_get',
    description: '抓取一个 http/https 网页，返回状态码、内容类型与正文（最多 8000 字符，自动去掉 HTML 标签）。',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string', description: '完整 URL，必须含 http:// 或 https://' } },
      required: ['url'],
      additionalProperties: false,
    },
    async run({ url }) {
      const target = new URL(String(url));
      if (!/^https?:$/.test(target.protocol)) throw new Error('只支持 http/https');
      assertPublicHost(target.hostname);
      const res = await fetch(target, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; chaoxing-coze-proxy-agent/1.0)' },
        redirect: 'follow',
        signal: AbortSignal.timeout(15_000),
      });
      const contentType = res.headers.get('content-type') ?? '';
      const body = await res.text();
      if (contentType.includes('json')) {
        return { status: res.status, contentType, body: clip(body) };
      }
      const text = body
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/\s+/g, ' ')
        .trim();
      const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(body)?.[1]?.trim();
      return {
        status: res.status,
        contentType,
        title,
        text: clip(text),
        // Raw markup for models that prefer to parse it themselves (capped so context stays sane).
        html: body.slice(0, 4_000),
      };
    },
  },
  {
    name: 'list_dir',
    description: '列出工作目录下某个子目录的文件与大小。参数 {"path":"相对路径，默认 ."}。',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: '相对工作根目录的路径，默认 .' } },
      additionalProperties: false,
    },
    async run({ path: target = '.' } = {}) {
      const dir = withinRoot(String(target));
      const entries = await fs.readdir(dir, { withFileTypes: true });
      return {
        dir: path.relative(ROOT, dir) || '.',
        entries: entries.slice(0, 200).map((entry) => ({ name: entry.name, dir: entry.isDirectory() })),
      };
    },
  },
  {
    name: 'read_file',
    description: '读取工作目录内的文本文件（最多 8000 字符）。参数 {"path":"相对路径"}。',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: '相对工作根目录的文件路径' } },
      required: ['path'],
      additionalProperties: false,
    },
    async run({ path: target }) {
      const file = withinRoot(String(target));
      const stat = await fs.stat(file);
      if (stat.size > 2_000_000) throw new Error(`文件过大（${stat.size} 字节）`);
      const content = await fs.readFile(file, 'utf8');
      return { path: path.relative(ROOT, file), size: stat.size, content: clip(content) };
    },
  },
  {
    name: 'write_file',
    description: '把文本写入工作目录内的文件（自动建目录，覆盖写入）。参数 {"path":"相对路径","content":"文本"}。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对工作根目录的文件路径' },
        content: { type: 'string', description: '要写入的完整文本' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
    async run({ path: target, content }) {
      const file = withinRoot(String(target));
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, String(content ?? ''), 'utf8');
      const stat = await fs.stat(file);
      return { path: path.relative(ROOT, file), bytes: stat.size };
    },
  },
  {
    name: 'exec',
    description:
      '在工作目录执行一条 PowerShell 命令并返回 stdout/stderr（超时 20 秒，输出最多 8000 字符）。用于真实计算、查询系统状态等。',
    parameters: {
      type: 'object',
      properties: { command: { type: 'string', description: '要执行的 PowerShell 命令' } },
      required: ['command'],
      additionalProperties: false,
    },
    async run({ command }) {
      if (!ALLOW_EXEC) throw new Error('exec 工具已被 AGENT_ALLOW_EXEC=0 禁用');
      return await new Promise((resolve) => {
        execFile(
          'powershell',
          ['-NoProfile', '-NonInteractive', '-Command', String(command)],
          { cwd: ROOT, timeout: 20_000, maxBuffer: 1024 * 1024, windowsHide: true },
          (error, stdout, stderr) => {
            resolve({
              exitCode: error?.code ?? 0,
              stdout: clip(String(stdout ?? '')),
              stderr: clip(String(stderr ?? '')),
            });
          },
        );
      });
    },
  },
];

export const toolByName = new Map(tools.map((tool) => [tool.name, tool]));

// The model sometimes invents plausible names ("fetch_url", "shell"); map them onto real tools
// instead of burning a round on "未知工具".
export const toolAliases = new Map([
  ['fetch_url', 'http_get'],
  ['fetch', 'http_get'],
  ['http_fetch', 'http_get'],
  ['web_fetch', 'http_get'],
  ['read_url', 'http_get'],
  ['curl', 'http_get'],
  ['get_url', 'http_get'],
  ['time', 'now'],
  ['current_time', 'now'],
  ['date', 'now'],
  ['ls', 'list_dir'],
  ['list_files', 'list_dir'],
  ['dir', 'list_dir'],
  ['cat', 'read_file'],
  ['read', 'read_file'],
  ['open_file', 'read_file'],
  ['write', 'write_file'],
  ['save_file', 'write_file'],
  ['create_file', 'write_file'],
  ['shell', 'exec'],
  ['run', 'exec'],
  ['bash', 'exec'],
  ['powershell', 'exec'],
  ['cmd', 'exec'],
]);

export function resolveTool(name) {
  return toolByName.get(name) ?? toolByName.get(toolAliases.get(name) ?? '') ?? null;
}

/** Compact tool catalogue for the prompt. */
export function describeTools(selected = tools) {
  return selected
    .map((tool) => {
      const params = tool.parameters?.properties ?? {};
      const rendered = Object.entries(params)
        .map(([key, value]) => `${key}: ${value.description ?? value.type ?? 'any'}${tool.parameters.required?.includes(key) ? '（必填）' : ''}`)
        .join('，');
      return `- ${tool.name}(${rendered || '无参数'})：${tool.description}`;
    })
    .join('\n');
}
