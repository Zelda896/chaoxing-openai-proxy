// Conversation/session store: one upstream visitor + conversation per client session.
import { createVisitor, connectVisitor, restoreVisitor } from './chaoxing.mjs';

const TTL_MS = 6 * 60 * 60 * 1000;
const MAX_SESSIONS = 500;
const sessions = new Map();

export function getSession(id) {
  const entry = sessions.get(id);
  if (!entry) return null;
  if (Date.now() - entry.lastUsed > TTL_MS) {
    sessions.delete(id);
    return null;
  }
  entry.lastUsed = Date.now();
  return entry.visitor;
}

export function setSession(id, visitor) {
  if (sessions.size >= MAX_SESSIONS) {
    const oldest = [...sessions.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
    if (oldest) sessions.delete(oldest[0]);
  }
  sessions.set(id, { visitor, lastUsed: Date.now() });
}

/** Reuse a visitor sent by the browser (page proxy) when it looks complete. */
export function visitorFromCookies(cookieHeader = '') {
  const jar = new Map();
  for (const part of cookieHeader.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) jar.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
  }
  const visitorId = jar.get('visitorId');
  const visitorVc = jar.get('visitorVc');
  if (!visitorId || !visitorVc) return null;
  return { visitorId, visitorVc, conversationId: jar.get('conversationId') ?? '', createdAt: Date.now() };
}

/** Get or create the session visitor for an API client. */
export async function ensureVisitor(sessionId, cookieHeader) {
  const existing = getSession(sessionId);
  if (existing) return existing;

  const fromCookie = visitorFromCookies(cookieHeader);
  if (fromCookie) {
    // Cookies carry identity but not the conversation; ask upstream to restore it.
    const restored = fromCookie.conversationId ? fromCookie : await restoreVisitor(fromCookie.visitorId);
    if (restored.conversationId) {
      await connectVisitor(restored);
      setSession(sessionId, restored);
      return restored;
    }
  }

  const visitor = await createVisitor();
  await connectVisitor(visitor);
  setSession(sessionId, visitor);
  return visitor;
}

export function updateConversation(sessionId, conversationId) {
  const entry = sessions.get(sessionId);
  if (!entry || !conversationId) return;
  entry.visitor.conversationId = conversationId;
}

export const sessionCount = () => sessions.size;
