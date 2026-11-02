// The agent loop: the upstream model acts by writing JavaScript, which we run in a sandboxed child
// process with real local tools behind `callTool`. One action block may chain many tool calls, which
// is what keeps the round count (and therefore latency) low on top of a 4–6 s ask-only upstream.
import { ask } from './chaoxing.mjs';
import { runAction } from './sandbox.mjs';
import { describeTools, tools as allTools } from './tools.mjs';
import { agentConfig } from './config.mjs';

const MAX_STEPS = agentConfig.maxSteps;
const STEP_TIMEOUT_MS = agentConfig.stepTimeoutMs;
const MAX_OBSERVATION = 5_000;
const MAX_NUDGES = 2;

// Canned replies the robot uses when its intent layer gives up; treat them as "no content".
const FALLBACK_PATTERNS = [/我还在努力学习/, /无法识别内容/, /换个方式考考我/, /没有理解您的意思/];
// The upstream sometimes refuses tool work outright; retry once with an explicit instruction.
const REFUSAL_PATTERNS = [/抱歉[，,]?\s*我(无法|不能)/, /无法执行/, /无法完成该?操作/, /没有(相关)?权限/, /不能(帮您)?执行/];
const looksLikeFallback = (text) => FALLBACK_PATTERNS.some((re) => re.test(text ?? ''));
const looksLikeRefusal = (text) => REFUSAL_PATTERNS.some((re) => re.test(text ?? ''));

function extractCode(text) {
  const fenced = /```(?:js|javascript)?\s*([\s\S]*?)```/i.exec(text ?? '');
  return fenced ? fenced[1].trim() : null;
}

// Models sometimes answer with a bare `final_answer("...")` instead of a code block; unwrap it.
function normalizeAnswer(text) {
  const trimmed = (text ?? '').trim();
  const match = /^(?:await\s+)?final_answer\s*\(\s*(['"`])([\s\S]*)\1\s*\)\s*;?$/.exec(trimmed);
  return match ? match[2].trim() : trimmed;
}

function buildPreamble(selected) {
  return [
    '你现在是一个用 JavaScript 调用工具的智能体。',
    '',
    '可用工具（用 await callTool("工具名", {参数}) 调用）：',
    describeTools(selected),
    '',
    '工作方式：',
    '1. 每个回合只输出一个 ```js 代码块，不要输出解释文字。',
    '2. 一个代码块里可以连续调用多个工具、循环处理结果，尽量减少回合数。',
    '3. console.log 的输出会作为观察结果回传给你。',
    '4. 能回答用户时调用 final_answer("完整的中文回答")。',
    '5. final_answer 的参数必须是字符串；拼接工具返回值时请用 JSON.stringify(result)。',
    '6. 不要使用 require、import、fs、process 等未提供的能力。',
    '7. 你确实可以调用下面这些本地工具，不要说“无法执行”；直接写代码即可。',
    '8. http_get 返回对象里已有 title / text / html 字段，网页标题直接用 result.title，不要对返回值做正则匹配。',
  ].join('\n');
}

/**
 * Run one agent turn.
 * Yields {type:'step'|'action'|'observation'|'delta'|'status'|'done'}
 */
export async function* runAgent(visitor, question, { maxSteps = MAX_STEPS, toolNames, signal } = {}) {
  const selected = toolNames?.length ? allTools.filter((tool) => toolNames.includes(tool.name)) : allTools;
  if (!selected.length) throw new Error(`没有可用的工具：${toolNames?.join(', ') ?? ''}`);
  const toolNameList = selected.map((tool) => tool.name);

  const trace = [];
  const startedAt = Date.now();
  let prompt = `${buildPreamble(selected)}\n\n用户问题：${question}`;
  let nudges = 0;
  let step = 0;

  for (step = 1; step <= maxSteps; step += 1) {
    yield { type: 'step', index: step, total: maxSteps };

    let text = '';
    let finishReason = 'unknown';
    for await (const event of ask(visitor, prompt, { signal })) {
      if (event.type === 'status') yield { type: 'status', text: event.text };
      else if (event.type === 'delta') text += event.text;
      else if (event.type === 'done') finishReason = event.finishReason;
    }

    const code = extractCode(text);

    if (!code) {
      const answer = normalizeAnswer(text);
      const empty = !answer || looksLikeFallback(answer);
      const refused = !empty && looksLikeRefusal(answer);
      if ((empty || refused) && nudges < MAX_NUDGES) {
        nudges += 1;
        trace.push({ step, kind: empty ? 'nudge' : 'refusal_retry' });
        prompt = [
          '你刚才没有给出可执行的内容。',
          `用户最初的问题是：「${question}」`,
          `请直接输出一个 \`\`\`js 代码块调用工具（可用：${toolNameList.join(', ')}），不要拒绝，也不要解释你做不到。`,
          '可以回答时调用 final_answer("...")。',
        ].join('\n');
        continue;
      }
      const finalText = empty ? '（本次未获得回答，请重试）' : answer;
      trace.push({ step, kind: 'final', text: finalText.slice(0, 400) });
      yield { type: 'delta', text: finalText };
      yield { type: 'done', text: finalText, step, elapsedMs: Date.now() - startedAt, finishReason, trace };
      return;
    }

    yield { type: 'action', step, code: code.slice(0, 4_000) };
    const outcome = await runAction(code, { tools: toolNameList, timeoutMs: STEP_TIMEOUT_MS });
    const output = [outcome.logs.join('\n'), outcome.error ? `错误：${outcome.error}` : ''].filter(Boolean).join('\n');

    trace.push({
      step,
      kind: 'action',
      code: code.slice(0, 300),
      output: output.slice(0, 300),
      toolCalls: outcome.toolCalls,
      final: Boolean(outcome.finalText),
    });
    yield {
      type: 'observation',
      step,
      output: output.slice(0, MAX_OBSERVATION),
      error: outcome.error ?? undefined,
      toolCalls: outcome.toolCalls,
      final: Boolean(outcome.finalText),
    };

    if (outcome.finalText) {
      trace.push({ step, kind: 'final', text: outcome.finalText.slice(0, 400) });
      yield { type: 'delta', text: outcome.finalText };
      yield {
        type: 'done',
        text: outcome.finalText,
        step,
        elapsedMs: Date.now() - startedAt,
        finishReason: 'final_answer',
        trace,
      };
      return;
    }

    prompt = [
      `代码执行输出：\n${output.slice(0, MAX_OBSERVATION) || '(无输出)'}`,
      `用户最初的问题是：「${question}」`,
      `请继续：需要更多信息就再输出一个 \`\`\`js 代码块（可用：${toolNameList.join(', ')}）；能回答时调用 final_answer("...")。`,
    ].join('\n');
  }

  const closing = `步数已用完。用户最初的问题是：「${question}」。请直接给出最终中文回答，不要再输出代码块。`;
  let text = '';
  for await (const event of ask(visitor, closing, { signal })) {
    if (event.type === 'delta') {
      text += event.text;
      yield { type: 'delta', text: event.text };
    } else if (event.type === 'done' && !text) {
      text = event.text ?? '';
    }
  }
  trace.push({ step, kind: 'final', text: text.slice(0, 400) });
  yield { type: 'done', text, step, elapsedMs: Date.now() - startedAt, finishReason: 'max_steps', trace };
}
