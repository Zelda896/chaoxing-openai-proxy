// Upstream protocol client: visitor bootstrap, HTTP helpers, and the chat WebSocket.
//
// Reverse-engineered flow (see ANALYSIS.md):
//   1. GET  /v1/front/chat/visitor/apply  -> { visitorId, visitorVc, cvsInfo.conversationId }
//   2. GET  /v1/front/chat/connect/{unitId}?visitorId&conversationId&robotId
//   3. WS   /v1/ws/chat/{unitId}/visitor?userId={visitorId}&visitorVc=...&conversationId=...
//   4. send one DATA frame holding msg.question, read SEMANTIC + DATA answer frames.
import WebSocket from 'ws';
import { config, upstreamHeaders } from './config.mjs';

class AsyncQueue {
  constructor() {
    this.items = [];
    this.waiters = [];
    this.done = false;
  }
  push(value) {
    if (this.done) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value, done: false });
    else this.items.push(value);
  }
  close() {
    if (this.done) return;
    this.done = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
  }
  [Symbol.asyncIterator]() {
    return {
      next: () => {
        if (this.items.length) return Promise.resolve({ value: this.items.shift(), done: false });
        if (this.done) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
      return: () => {
        this.close();
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}

/** Fetch JSON from the upstream API. Throws on transport / shape failure. */
export async function upstreamJson(path, { cookie, method = 'GET', body, headers = {} } = {}) {
  const res = await fetch(config.upstreamBase + path, {
    method,
    headers: upstreamHeaders({
      ...(cookie ? { Cookie: cookie } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    }),
    body,
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`upstream ${path} -> HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`upstream ${path} returned non-JSON: ${text.slice(0, 200)}`);
  }
}

export const cookieFor = (visitor) => `visitorId=${visitor.visitorId}; visitorVc=${visitor.visitorVc}`;

/** Create an anonymous visitor plus its first conversation. */
export async function createVisitor() {
  const query = new URLSearchParams({
    unitId: config.unitId,
    robotId: config.robotId,
    visitorId: '',
    channel: 'MOBILE',
    isLLMPlanning: '0',
    curTimestamp: String(Date.now()),
    safeformat: 'json',
  });
  const data = await upstreamJson(`/v1/front/chat/visitor/apply?${query}`);
  if (!data.visitorId || !data.visitorVc) {
    throw new Error(`visitor/apply did not return an identity: ${JSON.stringify(data).slice(0, 300)}`);
  }
  return {
    visitorId: data.visitorId,
    visitorVc: data.visitorVc,
    conversationId: data.cvsInfo?.conversationId ?? '',
    isNewVisitor: Boolean(data.isNewVisitor),
    createdAt: Date.now(),
  };
}

/** Re-create the visitor session upstream from a known visitor id (cookie round-trip). */
export async function restoreVisitor(visitorId) {
  const query = new URLSearchParams({
    unitId: config.unitId,
    robotId: config.robotId,
    visitorId,
    channel: 'MOBILE',
    isLLMPlanning: '0',
    curTimestamp: String(Date.now()),
    safeformat: 'json',
  });
  const data = await upstreamJson(`/v1/front/chat/visitor/apply?${query}`);
  return {
    visitorId: data.visitorId ?? visitorId,
    visitorVc: data.visitorVc,
    conversationId: data.cvsInfo?.conversationId ?? '',
    isNewVisitor: Boolean(data.isNewVisitor),
    createdAt: Date.now(),
  };
}

/** Register the visitor session upstream; the chat socket expects it. */
export async function connectVisitor(visitor) {
  const query = new URLSearchParams({
    visitorId: visitor.visitorId,
    conversationId: visitor.conversationId ?? '',
    robotId: config.robotId,
    unitId: config.unitId,
    curTimestamp: String(Date.now()),
    safeformat: 'json',
  });
  try {
    const data = await upstreamJson(`/v1/front/chat/connect/${config.unitId}?${query}`, {
      cookie: cookieFor(visitor),
    });
    return Boolean(data.status);
  } catch {
    return false;
  }
}

function buildQuestionFrame(question) {
  const now = Date.now();
  return {
    msgTimeId: now,
    time: now,
    direction: 'IN',
    messageType: 'TEXT',
    communicateType: 'DATA',
    lang: 'zh-CN',
    msg: {
      channel: 'WEB',
      question,
      visibleQuestion: question,
      questionType: 'TEXT',
      fileInfo: [],
      chatModel: 'DEFAULT',
      sourceChatModel: 'DEFAULT',
      digitalHumanName: 'ai馆员',
      taskInitParams: {},
    },
    robot: { type: '', scene: -1, subject: '', spage: 1 },
    dxNumber: '',
    d: '',
  };
}

function textFromAnswer(answer) {
  if (typeof answer !== 'string' || !answer) return null;
  if (!answer.trimStart().startsWith('{')) return { text: answer, final: false };
  try {
    const payload = JSON.parse(answer);
    return {
      text: typeof payload.responseText === 'string' ? payload.responseText : '',
      final: payload.flag === 'stop',
      message: typeof payload.message === 'string' ? payload.message : undefined,
      payload,
    };
  } catch {
    return { text: answer, final: false };
  }
}

/**
 * Ask one question and yield normalized events:
 *   { type: 'meta',   conversationId, visitorId }
 *   { type: 'status', text }
 *   { type: 'delta',  text }
 *   { type: 'link',   url, title }
 *   { type: 'done',   text, messageId, conversationId, elapsedMs, finishReason }
 */
async function* askOnce(visitor, question, { signal, state } = {}) {
  const queue = new AsyncQueue();
  const startedAt = Date.now();
  const wsUrl =
    `${config.upstreamWs}/v1/ws/chat/${config.unitId}/visitor?` +
    new URLSearchParams({
      unitId: config.unitId,
      robotId: config.robotId,
      userId: visitor.visitorId,
      channel: 'MOBILE',
      conversationId: visitor.conversationId ?? '',
      visitorVc: visitor.visitorVc,
      lang: 'zh-CN',
      isLLMPlanning: '0',
    });

  let socket;
  let text = '';
  let finished = false;
  let idleTimer;
  let keepaliveTimer;
  let timeoutTimer;

  const finish = (reason) => {
    if (finished) return;
    finished = true;
    clearTimeout(idleTimer);
    clearInterval(keepaliveTimer);
    clearTimeout(timeoutTimer);
    Object.assign(state ?? {}, {
      text,
      conversationId: visitor.conversationId,
      elapsedMs: Date.now() - startedAt,
      finishReason: reason,
    });
    queue.close();
    try {
      socket?.close();
    } catch {}
  };

  const touch = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => finish('idle'), config.answerIdleMs);
  };

  try {
    socket = new WebSocket(wsUrl, {
      headers: upstreamHeaders({ Cookie: cookieFor(visitor), Origin: config.upstreamBase }),
    });
  } catch (error) {
    Object.assign(state ?? {}, {
      text: '',
      error: String(error?.message ?? error),
      elapsedMs: 0,
      finishReason: 'error',
    });
    queue.close();
    return;
  }

  socket.on('open', () => {
    queue.push({
      type: 'meta',
      conversationId: visitor.conversationId,
      visitorId: visitor.visitorId,
    });
    socket.send(JSON.stringify(buildQuestionFrame(question)));
    keepaliveTimer = setInterval(() => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'KEEPALIVE' }));
    }, 25_000);
    timeoutTimer = setTimeout(() => finish('timeout'), config.answerTimeoutMs);
    touch();
  });

  socket.on('message', (raw) => {
    if (finished) return;
    let frame;
    try {
      frame = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (frame.type === 'SEMANTIC') {
      const description = frame.meta?.description;
      if (description) queue.push({ type: 'status', text: description });
      touch();
      return;
    }
    if (frame.type === 'FINAL_FINISH') {
      touch();
      return;
    }
    if (frame.communicateType !== 'DATA' && frame.answerContentType === undefined) return;

    const contentType = frame.answerContentType;

    if (contentType === 'TASK_FLOW_V3') {
      const payload = textFromAnswer(frame.answer);
      if (payload?.message) queue.push({ type: 'status', text: payload.message });
      const link = frame.mobileIframeUrl ?? frame.pcIframeUrl;
      if (link) queue.push({ type: 'link', url: link, title: frame.taskName ?? '任务流' });
      touch();
      if (frame.taskEnd) setTimeout(() => finish('task_end'), 300);
      return;
    }

    if (contentType !== 'TEXT') {
      // ACK_MSG / BUSINESS_QA placeholders and other control frames carry no text.
      if (frame.robotRespType || frame.answerType) touch();
      return;
    }

    const parsed = textFromAnswer(frame.answer);
    if (!parsed) return;

    // `systemMsg` frames are progress/title lines (e.g. the matched question), not the answer.
    if (frame.systemMsg === true) {
      if (parsed.text) queue.push({ type: 'status', text: parsed.text });
      touch();
      return;
    }

    if (parsed.text) {
      text += parsed.text;
      queue.push({ type: 'delta', text: parsed.text });
    }
    if (parsed.message) queue.push({ type: 'status', text: parsed.message });

    touch();

    if (parsed.final) {
      setTimeout(() => finish('stop'), 200);
    }
  });

  socket.on('error', (error) => {
    if (finished) return;
    finished = true;
    clearTimeout(idleTimer);
    clearInterval(keepaliveTimer);
    clearTimeout(timeoutTimer);
    Object.assign(state ?? {}, {
      text,
      error: String(error?.message ?? error),
      conversationId: visitor.conversationId,
      elapsedMs: Date.now() - startedAt,
      finishReason: 'error',
    });
    queue.close();
  });

  socket.on('close', () => finish('closed'));

  if (signal) {
    signal.addEventListener('abort', () => finish('aborted'), { once: true });
  }

  yield* queue;
}

/**
 * Ask a question, retrying once when the upstream drops the turn without any text
 * (an occasional first-turn race on freshly created visitors).
 */
export async function* ask(visitor, question, opts = {}) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const state = {};
    let emitted = false;
    for await (const event of askOnce(visitor, question, { ...opts, state })) {
      if (event.type === 'delta') emitted = true;
      yield event;
    }
    if (emitted || state.text) {
      yield { type: 'done', messageId: undefined, ...state };
      return;
    }
    if (attempt === 1 || opts.signal?.aborted) {
      yield { type: 'done', text: '', finishReason: state.finishReason ?? 'empty', ...state };
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
}
