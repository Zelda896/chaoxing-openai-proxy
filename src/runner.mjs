// Child-process runner for model-written JavaScript.
//
// Started by src/sandbox.mjs with Node's permission model (`--permission`), which denies filesystem,
// network and child-process access by default. The only capability the action gets is `callTool`,
// which is proxied over IPC to the parent process where the real tools live.
import vm from 'node:vm';

const MAX_LOG_ENTRIES = 200;
const pending = new Map();
let sequence = 0;

const format = (args) =>
  args
    .map((value) => {
      if (typeof value === 'string') return value;
      try {
        return JSON.stringify(value);
      } catch {
        return String(value);
      }
    })
    .join(' ');

process.on('message', async (message) => {
  if (message?.type === 'tool_result') {
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.ok) waiter.resolve(message.result);
    else waiter.reject(new Error(message.error ?? '工具执行失败'));
    return;
  }
  if (message?.type !== 'action') return;

  const logs = [];
  let finalText = null;
  // Models sometimes reach for `callTool("final_answer", {answer})` instead of calling `final_answer()`;
  // accept both shapes so a turn is not wasted on "未知工具".
  const finishWith = (value) => {
    finalText =
      typeof value === 'string'
        ? value
        : String(value?.answer ?? value?.text ?? value?.content ?? JSON.stringify(value ?? ''));
    return finalText;
  };
  const callTool = (name, args = {}) => {
    const toolName = String(name);
    if (toolName === 'final_answer' || toolName === 'finish' || toolName === 'answer') {
      return Promise.resolve(finishWith(args));
    }
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      pending.set(id, { resolve, reject });
      process.send({ type: 'tool', id, name: toolName, args });
    });
  };

  const sandbox = {
    console: {
      log: (...args) => {
        if (logs.length < MAX_LOG_ENTRIES) logs.push(format(args));
      },
      error: (...args) => {
        if (logs.length < MAX_LOG_ENTRIES) logs.push(`[err] ${format(args)}`);
      },
    },
    callTool,
    final_answer: (text) => {
      finalText = String(text ?? '');
      return finalText;
    },
    finish: (text) => {
      finalText = String(text ?? '');
      return finalText;
    },
    JSON,
    Math,
    Date,
    String,
    Number,
    Boolean,
    Array,
    Object,
    Promise,
    Map,
    Set,
    RegExp,
    Error,
    parseInt,
    parseFloat,
    isNaN,
    encodeURIComponent,
    decodeURIComponent,
    setTimeout,
    clearTimeout,
    availableTools: (message.tools ?? []).join(', '),
  };

  const context = vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });

  try {
    const script = new vm.Script(`(async () => {\n${message.code}\n})()`, { filename: 'agent-action.js' });
    await script.runInContext(context, { timeout: message.timeoutMs ?? 20_000 });
    process.send({ type: 'done', logs, finalText, error: null });
  } catch (error) {
    process.send({ type: 'done', logs, finalText, error: String(error?.message ?? error) });
  }
});
