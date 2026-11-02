// OpenAI surface in agent mode: the proxy runs the code-action loop locally and returns a normal completion.
const BASE = process.env.PROXY_BASE ?? 'http://127.0.0.1:8686';

const body = {
  model: 'chaoxing-ai-librarian',
  user: 'agent-openai-1',
  agent: true,
  messages: [{ role: 'user', content: '现在几点？把结果写到 openai-clock.txt。' }],
};

const res = await fetch(`${BASE}/v1/chat/completions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});
const data = await res.json();
console.log('non-stream', res.status, '| content:', (data.choices?.[0]?.message?.content ?? '').slice(0, 120));
console.log('agent:', JSON.stringify({ mode: data.agent?.mode, steps: data.agent?.steps, toolCalls: data.agent?.toolCalls }).slice(0, 120));

const streamRes = await fetch(`${BASE}/v1/chat/completions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    ...body,
    user: 'agent-openai-2',
    stream: true,
    messages: [{ role: 'user', content: '抓取 https://example.com 的标题。' }],
  }),
});
const raw = await streamRes.text();
const chunks = raw.split('\n\n').filter((line) => line.startsWith('data: '));
const events = chunks
  .filter((line) => line.includes('agent_event'))
  .map((line) => JSON.parse(line.slice(6)).agent_event)
  .filter(Boolean);
const content = chunks
  .filter((line) => !line.includes('agent_event') && !line.endsWith('[DONE]'))
  .map((line) => {
    try {
      return JSON.parse(line.slice(6)).choices?.[0]?.delta?.content ?? '';
    } catch {
      return '';
    }
  })
  .join('');

console.log('stream events:', events.map((e) => e.type).join(' → ') || '(none)');
console.log('stream content:', content.slice(0, 120));

const okEvents = events.some((e) => e.type === 'action');
const okContent = content.trim().length > 0 && /Example Domain/i.test(content);
console.log(okEvents && okContent ? '\nPASS  openai agent mode streams actions and a final answer' : '\nFAIL  openai agent mode');
process.exit(okEvents && okContent ? 0 : 1);
