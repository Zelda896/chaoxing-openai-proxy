// OpenAI API compatibility: the contract any stock client relies on.
// Runs without an API key (API_KEYS empty) — set API_KEYS to also exercise the auth path.
const BASE = process.env.PROXY_BASE ?? 'http://127.0.0.1:8686';
const KEY = process.env.TEST_API_KEY ?? '';
const auth = KEY ? { authorization: `Bearer ${KEY}` } : {};

const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};

const post = (path, body) =>
  fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...auth },
    body: JSON.stringify(body),
  });

async function main() {
  // 1. GET /v1/models
  const modelsRes = await fetch(`${BASE}/v1/models`, { headers: auth });
  const models = await modelsRes.json();
  check('GET /v1/models', modelsRes.ok && models.object === 'list' && models.data.length > 0, `${models.data?.length} models`);
  const modelId = models.data[0].id;

  // 2. GET /v1/models/:id
  const oneRes = await fetch(`${BASE}/v1/models/${encodeURIComponent(modelId)}`, { headers: auth });
  const one = await oneRes.json();
  check('GET /v1/models/:id', oneRes.ok && one.id === modelId);
  const missing = await fetch(`${BASE}/v1/models/nope-does-not-exist`, { headers: auth });
  const missingBody = await missing.json();
  check('unknown model -> 404 model_not_found', missing.status === 404 && missingBody.error?.code === 'model_not_found');

  // 3. non-stream completion
  const plain = await (await post('/v1/chat/completions', { model: modelId, messages: [{ role: 'user', content: '用一句话介绍你自己。' }] })).json();
  check(
    'non-stream completion shape',
    plain.object === 'chat.completion' &&
      plain.choices?.[0]?.message?.role === 'assistant' &&
      typeof plain.choices[0].message.content === 'string' &&
      plain.choices[0].message.content.length > 0 &&
      plain.usage?.total_tokens > 0,
    (plain.choices?.[0]?.message?.content ?? '').slice(0, 40),
  );

  // 4. stream completion
  const streamRes = await post('/v1/chat/completions', {
    model: modelId,
    stream: true,
    messages: [{ role: 'user', content: '用一句话介绍你自己。' }],
  });
  const sse = await streamRes.text();
  const chunks = sse
    .split('\n\n')
    .filter((block) => block.startsWith('data: '))
    .map((block) => block.slice(6));
  const doneMarker = chunks[chunks.length - 1] === '[DONE]';
  const parsed = chunks.filter((c) => c !== '[DONE]').map((c) => JSON.parse(c));
  const streamedText = parsed.map((c) => c.choices?.[0]?.delta?.content ?? '').join('');
  check(
    'stream completion shape',
    streamRes.ok &&
      streamRes.headers.get('content-type')?.includes('text/event-stream') &&
      doneMarker &&
      parsed[0]?.choices?.[0]?.delta?.role === 'assistant' &&
      streamedText.length > 0 &&
      parsed.some((c) => c.choices?.[0]?.finish_reason === 'stop'),
    `${parsed.length} chunks, [DONE]=${doneMarker}`,
  );

  // 5. stateless multi-turn: history resent every request must be understood
  const history = await (
    await post('/v1/chat/completions', {
      model: modelId,
      messages: [
        { role: 'system', content: '你在回答时保持简短。' },
        { role: 'user', content: '记住：我叫李雷。' },
        { role: 'assistant', content: '好的，李雷。' },
        { role: 'user', content: '我叫什么名字？' },
      ],
    })
  ).json();
  const answer = history.choices?.[0]?.message?.content ?? '';
  check('stateless history replay', answer.includes('李雷'), answer.slice(0, 50));

  // 6. client-supplied tools -> tool_calls (the client keeps execution authority)
  const toolCallResp = await (
    await post('/v1/chat/completions', {
      model: modelId,
      messages: [{ role: 'user', content: '北京现在天气怎么样？请调用工具查询。' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'get_weather',
            description: '查询某个城市的天气',
            parameters: { type: 'object', properties: { city: { type: 'string', description: '城市名' } }, required: ['city'] },
          },
        },
      ],
      tool_choice: 'auto',
    })
  ).json();
  const choice = toolCallResp.choices?.[0];
  const toolCalls = choice?.message?.tool_calls;
  check(
    'client tools -> tool_calls',
    choice?.finish_reason === 'tool_calls' &&
      Array.isArray(toolCalls) &&
      toolCalls[0]?.type === 'function' &&
      typeof toolCalls[0]?.function?.arguments === 'string',
    toolCalls ? `${toolCalls[0].function.name}(${toolCalls[0].function.arguments})` : 'no tool_calls',
  );

  // 7. tool role round-trip: feeding a tool result back must produce a final answer
  if (toolCalls) {
    const withResult = await (
      await post('/v1/chat/completions', {
        model: modelId,
        messages: [
          { role: 'user', content: '北京现在天气怎么样？' },
          { role: 'assistant', content: null, tool_calls: toolCalls },
          { role: 'tool', tool_call_id: toolCalls[0].id, name: toolCalls[0].function.name, content: '{"temperature":"18℃","weather":"晴"}' },
        ],
      })
    ).json();
    const finalText = withResult.choices?.[0]?.message?.content ?? '';
    check('tool result -> final answer', finalText.length > 0 && !finalText.trim().startsWith('{'), finalText.slice(0, 50));
  }

  // 8. agent mode through the OpenAI surface
  const agent = await (
    await post('/v1/chat/completions', {
      model: modelId,
      agent: true,
      max_steps: 3,
      messages: [{ role: 'user', content: '现在几点？用代码确认后回答我。' }],
    })
  ).json();
  check(
    'agent:true runs local tools',
    (agent.agent?.steps ?? 0) > 0 && (agent.choices?.[0]?.message?.content ?? '').length > 0,
    `steps=${agent.agent?.steps} tools=${agent.agent?.toolCalls}`,
  );

  // 9. error shapes
  const noMessages = await post('/v1/chat/completions', { model: modelId });
  const noMessagesBody = await noMessages.json();
  check('missing messages -> 400 with error object', noMessages.status === 400 && typeof noMessagesBody.error?.message === 'string');
  const noModel = await post('/v1/chat/completions', { messages: [{ role: 'user', content: 'hi' }] });
  check('missing model -> 400', noModel.status === 400);
  const conflict = await post('/v1/chat/completions', {
    model: modelId,
    agent: true,
    messages: [{ role: 'user', content: 'hi' }],
    tools: [{ type: 'function', function: { name: 'x', parameters: { type: 'object', properties: {} } } }],
  });
  check('tools + agent:true -> 400 (ambiguous authority)', conflict.status === 400);

  // 10. auth (only when keys are configured)
  if (KEY) {
    const unauth = await fetch(`${BASE}/v1/models`);
    const unauthBody = await unauth.json();
    check('missing key -> 401 authentication_error', unauth.status === 401 && unauthBody.error?.type === 'authentication_error');
  }

  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} OpenAI compatibility checks passed`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((error) => {
  console.error('compat test failed:', error);
  process.exit(1);
});
