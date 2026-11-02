// Parent side of the action sandbox: fork a permission-restricted child, execute the model's code
// there, proxy its tool calls back to this process, enforce a hard step deadline.
import path from 'node:path';
import { fork, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveTool } from './tools.mjs';
import { agentConfig } from './config.mjs';

const RUNNER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'runner.mjs');
const MAX_TOOL_CALLS = agentConfig.maxToolCalls;

// Node's permission model is `--permission` from v23 (older builds used `--experimental-permission`).
// Probe once so an older runtime degrades to a plain isolated child process instead of failing to boot.
let permissionFlag;
function resolvePermissionFlag() {
  if (permissionFlag !== undefined) return permissionFlag;
  const attempts = [['--permission'], ['--experimental-permission'], []];
  for (const args of attempts) {
    if (!args.length) {
      permissionFlag = '';
      return permissionFlag;
    }
    const probe = spawnSync(process.execPath, [...args, '-e', '0'], { stdio: 'ignore', windowsHide: true });
    if (probe.status === 0) {
      permissionFlag = args[0];
      return permissionFlag;
    }
  }
  permissionFlag = '';
  return permissionFlag;
}

/**
 * Execute one action block.
 * @returns {Promise<{logs: string[], finalText: string|null, error: string|null, toolCalls: number}>}
 */
export function runAction(code, { tools = [], timeoutMs = 30_000 } = {}) {
  return new Promise((resolve) => {
    const flag = resolvePermissionFlag();
    const child = fork(RUNNER, [], {
      execArgv: flag ? [flag] : [],
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: {
        PATH: process.env.PATH ?? '',
        SYSTEMROOT: process.env.SYSTEMROOT ?? '',
        NODE_NO_WARNINGS: '1',
      },
      windowsHide: true,
    });

    const logs = [];
    let finalText = null;
    let error = null;
    let toolCalls = 0;
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      try {
        child.kill();
      } catch {}
      resolve(result);
    };

    const deadline = setTimeout(
      () => finish({ logs, finalText, error: `步骤超时（${timeoutMs} ms），已终止沙箱`, toolCalls }),
      timeoutMs,
    );

    child.on('message', async (message) => {
      if (message?.type === 'tool') {
        toolCalls += 1;
        if (toolCalls > MAX_TOOL_CALLS) {
          child.send({ type: 'tool_result', id: message.id, ok: false, error: `单步工具调用超过 ${MAX_TOOL_CALLS} 次` });
          return;
        }
        const tool = resolveTool(message.name);
        if (!tool) {
          child.send({
            type: 'tool_result',
            id: message.id,
            ok: false,
            error: `未知工具 ${message.name}；可用：${tools.join(', ')}`,
          });
          return;
        }
        try {
          const result = await tool.run(message.args ?? {});
          logs.push(`[tool] ${message.name} -> ${JSON.stringify(result).slice(0, 1500)}`);
          child.send({ type: 'tool_result', id: message.id, ok: true, result });
        } catch (thrown) {
          child.send({ type: 'tool_result', id: message.id, ok: false, error: String(thrown?.message ?? thrown) });
        }
        return;
      }

      if (message?.type === 'done') {
        finish({
          logs: [...logs, ...(message.logs ?? [])].slice(-120),
          finalText: message.finalText ?? null,
          error: message.error ?? null,
          toolCalls,
        });
      }
    });

    child.on('error', (thrown) => finish({ logs, finalText, error: String(thrown?.message ?? thrown), toolCalls }));
    child.on('exit', (codeNumber) => {
      if (!settled) finish({ logs, finalText, error: codeNumber === 0 ? null : `沙箱异常退出（code ${codeNumber}）`, toolCalls });
    });

    child.send({ type: 'action', code, tools, timeoutMs: Math.max(timeoutMs - 2_500, 5_000) });
  });
}
