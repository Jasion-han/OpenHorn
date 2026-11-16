/** Bounded, user-scoped cancellation for retrieval performed before a Chat stream starts. */
type Entry = { controller: AbortController; active: boolean; expiresAt: number };
const preparations = new Map<string, Entry>();
const ttlMs = 120_000;
const keyFor = (userId: string, conversationId: string, token: string) =>
  JSON.stringify([userId, conversationId, token]);
function validate(token: string) {
  if (!/^[a-zA-Z0-9_-]{16,128}$/.test(token)) throw new Error("invalid_chat_preparation_token");
}
function prune() {
  for (const [key, value] of preparations)
    if (!value.active && value.expiresAt < Date.now()) preparations.delete(key);
}
export function beginChatPreparation(userId: string, conversationId: string, token?: string) {
  prune();
  if (!token) {
    const controller = new AbortController();
    return {
      signal: controller.signal,
      stop() {
        controller.abort();
      },
      finish() {},
    };
  }
  validate(token);
  const key = keyFor(userId, conversationId, token);
  const previous = preparations.get(key);
  if (previous?.active) throw new Error("chat_preparation_in_progress");
  if (!previous && preparations.size >= 256) throw new Error("chat_preparation_busy");
  const entry = previous ?? {
    controller: new AbortController(),
    active: false,
    expiresAt: Date.now() + ttlMs,
  };
  entry.active = true;
  preparations.set(key, entry);
  return {
    signal: entry.controller.signal,
    stop() {
      entry.controller.abort(new DOMException("Chat preparation stopped", "AbortError"));
    },
    finish() {
      entry.active = false;
      if (entry.controller.signal.aborted) entry.expiresAt = Date.now() + ttlMs;
      else if (preparations.get(key) === entry) preparations.delete(key);
    },
  };
}
export function cancelChatPreparation(userId: string, conversationId: string, token: string): void {
  validate(token);
  prune();
  const key = keyFor(userId, conversationId, token);
  let entry = preparations.get(key);
  if (!entry) {
    if (preparations.size >= 256) throw new Error("chat_preparation_busy");
    entry = { controller: new AbortController(), active: false, expiresAt: Date.now() + ttlMs };
    preparations.set(key, entry);
  }
  entry.controller.abort(new DOMException("Chat preparation stopped", "AbortError"));
}
