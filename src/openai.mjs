// OpenAI-compatible surface.
//
// Goal: any OpenAI client (SDK, Open WebUI, LobeChat, Cursor, Chatbox, …) can point at this server and
// just work. That means more than the happy path:
//   * /v1/models and /v1/models/:id
//   * /v1/chat/completions with stream:true|false
//   * client-supplied `tools` translated to/from tool_calls (the upstream has no native tool calling,
//     so this is a prompt-level protocol; the caller keeps execution authority)
//   * stateless clients: the whole `messages` history is replayed into one upstream turn
//   * multi-turn continuity for stateful clients via `user` (one upstream visitor per session)
//   * OpenAI-shaped error bodies so SDKs raise proper exceptions
import crypto from 'node:crypto';
import { config } from './config.mjs';
import { ask } from './chaoxing.mjs';
import { ensureVisitor, updateConversation } from './sessions.mjs';
import { runAgent } from './agent.mjs';
import { tools as localTools } from './tools.mjs';

const approxTokens = (text) => (text ? Math.max(1, Math.round(text.length / 1.8)) : 0);
const now = () => Math.floor(Date.now() / 1000);

export function openaiError(res, status, message, type = 'invalid_request_error', code = null) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }).end(
    JSON.stringify({ error: { message, type, code, param: null } }),
  );
}

export function listModels() {
  const created = now();
  const models = [
    { id: config.modelName, object: 'model', created, owned_by: 'chaoxing' },
    { id: 'deepseek-v4-flash-0731', object: 'model', created, owned_by: 'chaoxing' },
  ];
  for (const extra of config.modelAliases) {
    if (!models.some((model) => model.id === extra)) {
      models.push({ id: extra, object: 'model', created, owned_by: 'chaoxing' });
    }
  }
  return { object: 'list', data: models };
}

export function getModel(modelId) {
  const found = listModels().data.find((model) => model.id === modelId);
  return found ? { id: found.id, object: 'model', created: found.created, owned_by: found.owned_by } : null;
}

/** Flatten OpenAI message content (string or content-part array) to text. */
function contentToText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (part?.type === 'text' && typeof part.text === 'string') return part.text;
      if (part?.type === 'image_url') return `[图片] ${part.image_url?.url ?? ''}`;
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

/**
 * Build the single upstream prompt from an OpenAI conversation.
 * The upstream keeps no client-visible history, so we replay it here — this is what makes the proxy
 * usable by stateless clients that resend the whole conversation on every request.
 */
export function buildPrompt(messages = []) {
  const transcript = [];
  let system = '';
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;
    if (message.role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length) {
      // An assistant turn that requested tools: keep the intent visible so the loop reads naturally.
      const calls = message.tool_calls
        .map((call) => `${call?.function?.name ?? 'tool'}(${call?.function?.arguments ?? '{}'})`)
        .join('、');
      const note = contentToText(message.content).trim();
      transcript.push({ role: 'assistant', text: `[调用工具] ${calls}${note ? ` ${note}` : ''}` });
      continue;
    }
    const text = contentToText(message.content).trim();
    if (!text) continue;
    if (message.role === 'system' || message.role === 'developer') {
      system += (system ? '\n' : '') + text;
    } else if (message.role === 'user' || message.role === 'assistant') {
      transcript.push({ role: message.role, text });
    } else if (message.role === 'tool') {
      transcript.push({ role: 'tool', name: message.name ?? 'tool', text });
    }
  }

  const lastUserIndex = transcript.map((entry) => entry.role).lastIndexOf('user');
  if (lastUserIndex < 0) return '';
  const question = transcript[lastUserIndex].text;

  // Everything before the question is history; tool results *after* it are the freshest observations
  // (the OpenAI tool-calling round trip puts them there) and must reach the model too.
  const history = transcript.slice(0, lastUserIndex);
  const observations = transcript.slice(lastUserIndex + 1);

  if (!history.length && !observations.length && !system) return question;

  const lines = [];
  if (system) lines.push(`系统指令：${system}`, '');
  if (history.length) {
    lines.push('以下是对话历史：');
    for (const entry of history) {
      const who = entry.role === 'user' ? '用户' : entry.role === 'assistant' ? '助手' : `工具 ${entry.name}`;
      lines.push(`${who}：${entry.text}`);
    }
    lines.push('');
  }
  lines.push(`用户：${question}`, '');
  if (observations.length) {
    lines.push('已获得的工具返回结果（请直接据此作答，不要声称无法获取）：');
    for (const entry of observations) {
      lines.push(entry.role === 'tool' ? `工具 ${entry.name}：${entry.text}` : `${entry.role === 'user' ? '用户' : '助手'}：${entry.text}`);
    }
    lines.push('');
  }
  lines.push('请直接回答上面这个用户问题。');
  return lines.join('\n');
}

/** Prompt-level tool protocol for client-supplied OpenAI tools. */
function buildToolsPreamble(tools = [], toolChoice) {
  const rendered = tools
    .map((entry) => {
      const fn = entry?.function ?? entry;
      if (!fn?.name) return null;
      const params = fn.parameters?.properties ?? {};
      const required = new Set(fn.parameters?.required ?? []);
      const args = Object.entries(params)
        .map(([key, value]) => `${key}: ${value?.description ?? value?.type ?? 'any'}${required.has(key) ? '（必填）' : ''}`)
        .join('，');
      return `- ${fn.name}(${args || '无参数'})：${fn.description ?? ''}`;
    })
    .filter(Boolean);
  if (!rendered.length) return '';

  const forced =
    toolChoice === 'required'
      ? '本次必须调用一个工具。'
      : typeof toolChoice === 'object' && toolChoice?.function?.name
        ? `本次必须调用工具 ${toolChoice.function.name}。`
        : '';
  return [
    '你可以调用以下工具：',
    ...rendered,
    '',
    '调用规则：',
    '1. 需要工具时只输出一行 JSON：{"tool":"工具名","args":{...}}，不要输出解释，不要用代码块。',
    '2. 一次只调用一个工具。',
    '3. 收到工具结果后，能回答就直接用中文回答；需要别的信息再输出 JSON。',
    forced,
  ]
    .filter(Boolean)
    .join('\n');
}

/** Extract `{"tool":…}` from an answer produced under the client-tools protocol. */
export function parseClientToolCall(text) {
  const cleaned = String(text ?? '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '');
  const candidates = [cleaned];
  const braced = /\{[\s\S]*\}/.exec(cleaned);
  if (braced) candidates.push(braced[0]);
  for (const candidate of candidates) {
    let parsed;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== 'object') continue;
    const name = parsed.tool ?? parsed.name ?? parsed.function?.name;
    if (typeof name !== 'string' || !name) continue;
    let args = parsed.args ?? parsed.arguments ?? parsed.function?.arguments ?? {};
    if (typeof args === 'string') {
      try {
        args = JSON.parse(args);
      } catch {
        args = {};
      }
    }
    return { name, arguments: JSON.stringify(args && typeof args === 'object' ? args : {}) };
  }
  return null;
}

const streamChunk = (id, created, model, delta, finishReason = null) => ({
  id,
  object: 'chat.completion.chunk',
  created,
  model,
  choices: [{ index: 0, delta, finish_reason: finishReason }],
});

const writeSse = (res, payload) =>
  res.write(`data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`);

function startSse(res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
}

function completion({ id, created, model, content, finishReason, toolCalls, promptText }) {
  const message = { role: 'assistant', content: toolCalls ? null : content };
  if (toolCalls) message.tool_calls = toolCalls;
  return {
    id,
    object: 'chat.completion',
    created,
    model,
    choices: [{ index: 0, message, finish_reason: finishReason }],
    usage: {
      prompt_tokens: approxTokens(promptText),
      completion_tokens: approxTokens(content),
      total_tokens: approxTokens(promptText) + approxTokens(content),
    },
  };
}

/** Collect one upstream answer to a prompt. */
async function collect(visitor, prompt, signal) {
  let text = '';
  let conversationId;
  for await (const event of ask(visitor, prompt, { signal })) {
    if (event.type === 'delta') text += event.text;
    else if (event.type === 'done') {
      if (event.conversationId) conversationId = event.conversationId;
      if (!text && event.text) text = event.text;
    }
  }
  return { text, conversationId };
}

/**
 * Client-supplied tools: negotiate one call through the prompt protocol and hand it back as tool_calls.
 * We never execute a client's tool — that stays the caller's authority.
 */
async function negotiateClientTools({ visitor, prompt, tools, toolChoice, signal }) {
  const preamble = buildToolsPreamble(tools, toolChoice);
  const first = await collect(visitor, `${preamble}\n\n用户问题：${prompt}`, signal);
  const call = parseClientToolCall(first.text);
  if (!call) return { kind: 'answer', text: first.text, conversationId: first.conversationId };
  return {
    kind: 'tool_calls',
    toolCalls: [{ id: `call_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`, type: 'function', function: call }],
    conversationId: first.conversationId,
  };
}

/**
 * POST /v1/chat/completions
 * Extra request fields (ignored by stock OpenAI clients, opt-in here):
 *   agent: true        run the sandboxed code-action loop with this server's local tools
 *   agent_tools: [...] restrict which local tools the agent may use
 *   max_steps: n       agent step budget
 */
export async function handleChatCompletions(req, res, body, { authorize } = {}) {
  if (authorize && !authorize(req)) {
    return openaiError(res, 401, 'Incorrect API key provided', 'authentication_error', 'invalid_api_key');
  }

  const messages = Array.isArray(body.messages) ? body.messages : null;
  if (!messages) return openaiError(res, 400, "Missing required parameter: 'messages'");
  if (!body.model) return openaiError(res, 400, "Missing required parameter: 'model'");

  const prompt = buildPrompt(messages);
  if (!prompt) return openaiError(res, 400, 'messages must contain a user message with text content');

  const stream = Boolean(body.stream);
  const clientTools = Array.isArray(body.tools) ? body.tools : [];
  const agentMode = body.agent === true || req.headers['x-agent-mode'] === 'local';
  if (clientTools.length && agentMode) {
    return openaiError(
      res,
      400,
      '`tools` and `agent:true` are mutually exclusive: `tools` are executed by the client, agent tools by this server',
    );
  }

  const sessionId = String(body.user ?? body.conversation_id ?? body.session_id ?? crypto.randomUUID());
  let visitor;
  try {
    visitor = await ensureVisitor(sessionId, req.headers.cookie);
  } catch (error) {
    return openaiError(res, 502, `upstream session failed: ${error?.message ?? error}`, 'upstream_error');
  }

  const id = `chatcmpl-${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
  const created = now();
  const model = body.model;

  const controller = new AbortController();
  req.on('close', () => controller.abort());
  const { signal } = controller;

  try {
    if (agentMode) {
      const toolNames = Array.isArray(body.agent_tools) ? body.agent_tools.map(String) : undefined;
      const maxSteps = Math.min(Math.max(Number(body.max_steps ?? body.max_rounds ?? 6), 1), 10);

      if (stream) {
        startSse(res);
        writeSse(res, streamChunk(id, created, model, { role: 'assistant', content: '' }));
        let content = '';
        for await (const event of runAgent(visitor, prompt, { maxSteps, toolNames, signal })) {
          if (event.type === 'delta') {
            content += event.text;
            writeSse(res, streamChunk(id, created, model, { content: event.text }));
          } else if (event.type === 'step' || event.type === 'action' || event.type === 'observation') {
            writeSse(res, { ...streamChunk(id, created, model, {}), agent_event: event });
          }
        }
        writeSse(res, streamChunk(id, created, model, {}, 'stop'));
        writeSse(res, {
          id,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [],
          usage: {
            prompt_tokens: approxTokens(prompt),
            completion_tokens: approxTokens(content),
            total_tokens: approxTokens(prompt) + approxTokens(content),
          },
        });
        writeSse(res, '[DONE]');
        res.end();
        return;
      }

      let content = '';
      let trace = [];
      for await (const event of runAgent(visitor, prompt, { maxSteps, toolNames, signal })) {
        if (event.type === 'delta') content += event.text;
        else if (event.type === 'done') trace = event.trace ?? [];
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }).end(
        JSON.stringify({
          ...completion({ id, created, model, content, finishReason: 'stop', promptText: prompt }),
          agent: {
            mode: 'code',
            steps: trace.filter((step) => step.kind === 'action').length,
            toolCalls: trace.reduce((sum, entry) => sum + (entry.toolCalls ?? 0), 0),
            trace,
          },
        }),
      );
      return;
    }

    if (clientTools.length) {
      const outcome = await negotiateClientTools({ visitor, prompt, tools: clientTools, toolChoice: body.tool_choice, signal });
      if (outcome.conversationId) updateConversation(sessionId, outcome.conversationId);

      if (outcome.kind === 'tool_calls') {
        const [call] = outcome.toolCalls;
        if (stream) {
          startSse(res);
          writeSse(res, streamChunk(id, created, model, { role: 'assistant', content: null }));
          writeSse(
            res,
            streamChunk(id, created, model, {
              tool_calls: [{ index: 0, id: call.id, type: 'function', function: call.function }],
            }),
          );
          writeSse(res, streamChunk(id, created, model, {}, 'tool_calls'));
          writeSse(res, '[DONE]');
          res.end();
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }).end(
          JSON.stringify(
            completion({
              id,
              created,
              model,
              content: '',
              finishReason: 'tool_calls',
              toolCalls: outcome.toolCalls,
              promptText: prompt,
            }),
          ),
        );
        return;
      }

      if (stream) {
        startSse(res);
        writeSse(res, streamChunk(id, created, model, { role: 'assistant', content: '' }));
        if (outcome.text) writeSse(res, streamChunk(id, created, model, { content: outcome.text }));
        writeSse(res, streamChunk(id, created, model, {}, 'stop'));
        writeSse(res, '[DONE]');
        res.end();
        return;
      }
      res
        .writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        .end(JSON.stringify(completion({ id, created, model, content: outcome.text, finishReason: 'stop', promptText: prompt })));
      return;
    }

    if (!stream) {
      const outcome = await collect(visitor, prompt, signal);
      if (outcome.conversationId) updateConversation(sessionId, outcome.conversationId);
      res
        .writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        .end(JSON.stringify(completion({ id, created, model, content: outcome.text, finishReason: 'stop', promptText: prompt })));
      return;
    }

    startSse(res);
    writeSse(res, streamChunk(id, created, model, { role: 'assistant', content: '' }));
    let content = '';
    for await (const event of ask(visitor, prompt, { signal })) {
      if (event.type === 'delta') {
        content += event.text;
        writeSse(res, streamChunk(id, created, model, { content: event.text }));
      } else if (event.type === 'done') {
        if (event.conversationId) updateConversation(sessionId, event.conversationId);
        if (!content && event.text) {
          content = event.text;
          writeSse(res, streamChunk(id, created, model, { content: event.text }));
        }
      }
    }
    writeSse(res, streamChunk(id, created, model, {}, 'stop'));
    writeSse(res, {
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [],
      usage: {
        prompt_tokens: approxTokens(prompt),
        completion_tokens: approxTokens(content),
        total_tokens: approxTokens(prompt) + approxTokens(content),
      },
    });
    writeSse(res, '[DONE]');
    res.end();
  } catch (error) {
    if (res.headersSent) {
      writeSse(res, { error: { message: String(error?.message ?? error), type: 'upstream_error' } });
      res.end();
      return;
    }
    openaiError(res, 502, String(error?.message ?? error), 'upstream_error');
  }
}

/** GET /v1/models/:id */
export function handleModelById(res, modelId) {
  const model = getModel(modelId);
  if (!model) return openaiError(res, 404, `The model '${modelId}' does not exist`, 'invalid_request_error', 'model_not_found');
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify(model));
}

/** GET /v1/agent/tools — this server's local tool catalogue, in OpenAI function shape. */
export function listAgentTools() {
  return {
    object: 'list',
    data: localTools.map((tool) => ({
      type: 'function',
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    })),
  };
}
