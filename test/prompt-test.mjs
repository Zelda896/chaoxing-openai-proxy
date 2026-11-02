// Unit tests for the prompt builder — the piece that makes stateless OpenAI clients work.
import { buildPrompt, parseClientToolCall } from '../src/openai.mjs';

const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};

// 1. single user message stays clean (no scaffolding noise for the upstream intent matcher)
const single = buildPrompt([{ role: 'user', content: '图书馆几点开门？' }]);
check('single message passthrough', single === '图书馆几点开门？', JSON.stringify(single.slice(0, 40)));

// 2. history is replayed
const history = buildPrompt([
  { role: 'user', content: '我叫李雷' },
  { role: 'assistant', content: '你好李雷' },
  { role: 'user', content: '我叫什么' },
]);
check('history replay keeps earlier turns', /我叫李雷/.test(history) && /你好李雷/.test(history) && /我叫什么/.test(history));

// 3. system prompt survives
const withSystem = buildPrompt([
  { role: 'system', content: '只回答四个字' },
  { role: 'user', content: '介绍你自己' },
]);
check('system prompt preserved', /只回答四个字/.test(withSystem));

// 4. tool results AFTER the question must be included (regression: they used to be dropped)
const toolRoundTrip = buildPrompt([
  { role: 'user', content: '北京天气？' },
  { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"北京"}' } }] },
  { role: 'tool', tool_call_id: 'c1', name: 'get_weather', content: '{"temperature":"18℃"}' },
]);
check('tool result after question is kept', /18℃/.test(toolRoundTrip), toolRoundTrip.replace(/\n/g, ' ⏎ ').slice(0, 120));
check('tool call intent is visible', /get_weather/.test(toolRoundTrip));
check('explicit "do not claim you cannot" hint', /不要声称无法获取/.test(toolRoundTrip));

// 5. content parts
const parts = buildPrompt([{ role: 'user', content: [{ type: 'text', text: '第一段' }, { type: 'text', text: '第二段' }] }]);
check('content parts flattened', parts.includes('第一段') && parts.includes('第二段'));

// 6. no user message -> empty (caller returns 400)
check('no user message -> empty', buildPrompt([{ role: 'assistant', content: 'hi' }]) === '');

// 7. client tool-call parsing, including fenced and alias shapes
const shapes = [
  ['{"tool":"get_weather","args":{"city":"北京"}}', 'get_weather', '{"city":"北京"}'],
  ['```json\n{"name":"search","arguments":{"q":"x"}}\n```', 'search', '{"q":"x"}'],
  ['{"function":{"name":"now","arguments":"{}"}}', 'now', '{}'],
];
for (const [input, name, args] of shapes) {
  const parsed = parseClientToolCall(input);
  check(`parse ${name}`, parsed?.name === name && parsed?.arguments === args, JSON.stringify(parsed));
}
check('plain prose is not a tool call', parseClientToolCall('今天天气不错，18℃。') === null);

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} prompt-builder checks passed`);
process.exit(passed === results.length ? 0 : 1);
