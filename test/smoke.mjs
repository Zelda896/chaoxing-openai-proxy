// End-to-end smoke test against a running proxy instance.
const BASE = process.env.PROXY_BASE ?? 'http://127.0.0.1:8686';
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};

async function health() {
  const res = await fetch(`${BASE}/healthz`);
  const body = await res.json();
  check('healthz', res.ok && body.ok === true, `sessions=${body.sessions}`);
}

async function sseChat(question, sessionId) {
  const res = await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: question, sessionId }),
  });
  const text = await res.text();
  const deltas = [...text.matchAll(/event: delta\ndata: (.+)/g)].map((m) => JSON.parse(m[1]).text);
  const done = /event: done\ndata: (.+)/.exec(text);
  const session = /event: session\ndata: (.+)/.exec(text);
  return {
    ok: res.ok,
    answer: deltas.join(''),
    done: done ? JSON.parse(done[1]) : null,
    sessionId: session ? JSON.parse(session[1]).sessionId : null,
    raw: text,
  };
}

async function openaiStream(question, user) {
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'chaoxing-ai-librarian', user, stream: true, messages: [{ role: 'user', content: question }] }),
  });
  const text = await res.text();
  const chunks = [...text.matchAll(/^data: (.+)$/gm)].map((m) => m[1]).filter((d) => d !== '[DONE]').map((d) => JSON.parse(d));
  const content = chunks.map((c) => c.choices?.[0]?.delta?.content ?? '').join('');
  return { ok: res.ok, content, chunks: chunks.length };
}

async function main() {
  await health();

  const qa = await sseChat('图书馆开放时间是什么时候？');
  check('sse chat answers a QA-library question', qa.ok && qa.answer.length > 0, qa.answer.slice(0, 60));

  const followUp = await sseChat('那周末也开放吗？', qa.sessionId);
  check('sse chat keeps the session (follow-up)', followUp.ok && followUp.answer.length > 0, followUp.answer.slice(0, 60));

  const llm = await sseChat('用一句话介绍你自己，不要超过40个字。');
  check('sse chat answers an LLM question', llm.ok && llm.answer.length > 10, llm.answer.slice(0, 60));

  const streamed = await openaiStream('用一句话介绍你自己。', 'smoke-openai-1');
  check('openai stream returns chunks', streamed.ok && streamed.chunks > 1 && streamed.content.length > 0, `${streamed.chunks} chunks`);

  const plain = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'chaoxing-ai-librarian', user: 'smoke-openai-2', messages: [{ role: 'user', content: '你好' }] }),
  }).then((r) => r.json());
  check('openai non-stream returns a completion', Boolean(plain.choices?.[0]?.message?.content), (plain.choices?.[0]?.message?.content ?? '').slice(0, 50));

  const models = await fetch(`${BASE}/v1/models`).then((r) => r.json());
  check('openai models list', Array.isArray(models.data) && models.data.length > 0);

  const agentTools = await fetch(`${BASE}/v1/agent/tools`).then((r) => r.json());
  check('agent tool catalogue', Array.isArray(agentTools.data) && agentTools.data.length >= 5, `${agentTools.data?.length ?? 0} tools`);

  const agentRun = await fetch(`${BASE}/v1/agent/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: '现在几点？用代码确认后告诉我。', maxSteps: 3 }),
  }).then((r) => r.text());
  const agentEvents = [...agentRun.matchAll(/event: (.*)\ndata: (.+)/g)].map((m) => ({ type: m[1], data: JSON.parse(m[2]) }));
  const actions = agentEvents.filter((e) => e.type === 'action');
  const agentAnswer = agentEvents.filter((e) => e.type === 'delta').map((e) => e.data.text).join('');
  check('agent runs a sandboxed action', actions.length > 0 && /callTool/.test(actions[0].data.code), `${actions.length} action(s)`);
  check('agent returns a final answer', agentAnswer.trim().length > 0, agentAnswer.slice(0, 50));

  const page = await fetch(`${BASE}/coze/mobile?unitId=21354&robotId=dfda0d9629b34e0fa59a9b57834b8c56`);
  const html = await page.text();
  check('original page proxied', page.ok && html.includes('id="app"'), `${page.status} ${html.length}B`);
  check('page is embeddable (no XFO)', !page.headers.get('x-frame-options'));

  const script = await fetch(`${BASE}/static/js/index.175232b3.js`);
  check('page asset proxied', script.ok && (await script.text()).length > 10000, script.status);

  const api = await fetch(`${BASE}/v1/front/getInfoByUnitId?unitId=21354&robotId=dfda0d9629b34e0fa59a9b57834b8c56&safeformat=json`);
  const apiJson = await api.json();
  check('upstream API proxied', api.ok && (apiJson.statusCode === 0 || apiJson.code === 1 || apiJson.data), JSON.stringify(apiJson).slice(0, 80));

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((error) => {
  console.error('smoke failed:', error);
  process.exit(1);
});
