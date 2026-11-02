// End-to-end agent scenarios against a running proxy (code-as-action, sandboxed).
const BASE = process.env.PROXY_BASE ?? 'http://127.0.0.1:8686';

async function agent(question, { tools, maxSteps = 6 } = {}) {
  const res = await fetch(`${BASE}/v1/agent/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: question, maxSteps, ...(tools ? { tools } : {}) }),
  });
  const raw = await res.text();
  if (!raw.includes('event:')) return { error: `non-SSE ${res.status}: ${raw.slice(0, 200)}`, actions: [], text: '' };
  const events = [...raw.matchAll(/event: (.*)\ndata: (.+)/g)].map((m) => ({ type: m[1], data: JSON.parse(m[2]) }));
  return {
    text: events.filter((e) => e.type === 'delta').map((e) => e.data.text).join(''),
    actions: events.filter((e) => e.type === 'action').map((e) => e.data),
    observations: events.filter((e) => e.type === 'observation').map((e) => e.data),
    steps: events.filter((e) => e.type === 'step').length,
    done: events.find((e) => e.type === 'done')?.data,
  };
}

const cases = [
  { question: '现在几点？用代码获取时间再回答我。', expect: /now/, wants: (r) => /\d{1,2}[:：]\d{2}|\d{1,2}点/.test(r.text) },
  { question: '抓取 https://example.com 这个页面，告诉我它的标题。', expect: /http_get/, wants: (r) => /Example Domain/i.test(r.text) },
  { question: '把当前时间写进 agent-time.txt。', expect: /write_file/, wants: (r) => r.text.trim().length > 0 },
  { question: '在工作目录执行命令输出当前目录，然后告诉我。', expect: /exec/, wants: (r) => /agent-sandbox|D:\\/i.test(r.text) },
  {
    question: '一次取回 https://example.com 和 https://www.iana.org/help/example-domains 两个页面的标题，对比后告诉我。',
    expect: /http_get/,
    wants: (r) => r.text.trim().length > 0,
    batch: true,
  },
];

let failures = 0;
for (const testCase of cases) {
  const result = await agent(testCase.question);
  const code = result.actions.map((a) => a.code).join('\n');
  const usedTool = testCase.expect.test(code);
  const answered = result.text.trim().length > 0;
  const satisfied = testCase.wants(result);
  const batched = testCase.batch ? (result.observations[0]?.toolCalls ?? 0) >= 2 : true;
  const ok = usedTool && answered && satisfied && batched;
  if (!ok) failures += 1;
  console.log(`\n${ok ? 'PASS' : 'FAIL'}  ${testCase.question}`);
  console.log(`   action 命中 ${testCase.expect}: ${usedTool} · 步数 ${result.steps} · 首步工具调用 ${result.observations[0]?.toolCalls ?? 0}`);
  console.log(`   answer: ${result.text.trim().slice(0, 160).replace(/\n/g, ' ')}`);
}

console.log(`\n${cases.length - failures}/${cases.length} agent scenarios passed`);
process.exit(failures ? 1 : 0);
