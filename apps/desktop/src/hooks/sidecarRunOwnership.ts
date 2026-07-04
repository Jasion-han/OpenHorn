/**
 * Run-ownership registry for sidecar agent runs.
 *
 * Regenerate re-uses the SAME assistant message id: the retry path clears the
 * bubble and calls startRun again while the previous run may still be
 * streaming. cancelRun is best-effort only — in-flight events from the old run
 * can still arrive after the new run started, and chatStore appends deltas
 * purely by message id, so two runs would interleave character-by-character
 * into one message (and the polluted text would be persisted as-is).
 *
 * Ownership is the safety net: every startRun claims a fresh token for the
 * message ids it writes to, and every callback of a run (onEvent / onError /
 * onDone / persist) first checks that its token is still the current owner.
 * A superseded run's late events are dropped wholesale — no store writes, no
 * persistence, no UI state changes.
 */

// Module-level so every hook instance (and every startRun closure) shares the
// same registry — the whole point is arbitrating between overlapping runs.
// Entries are kept for the app session on purpose: an id's owner must stay
// checkable for as long as that run's late events can still arrive, and there
// is no safe point to know that. Each entry is one string key + one symbol,
// bounded by the number of assistant messages run in this session.
const owners = new Map<string, symbol>();

/**
 * Registers a new run as the exclusive owner of the given message ids,
 * disowning whatever run held them before. Returns the run's owner token.
 */
export function claimRunOwnership(messageIds: Array<string | undefined>): symbol {
  const token = Symbol("sidecar-run-owner");
  for (const id of messageIds) {
    if (id) owners.set(id, token);
  }
  return token;
}

/** True while `token` is still the latest claim on `messageId`. */
export function isRunOwner(messageId: string, token: symbol): boolean {
  return owners.get(messageId) === token;
}

/**
 * Per-run persistence guard: returns true exactly once, and only while the
 * run still owns its message. Replaces the old hook-level `persistedRef`,
 * which a new run would reset — letting the previous run's late done/error
 * persist stale or interleave-polluted content over the new run's result.
 */
export function createRunPersistGuard(messageId: string, token: symbol): () => boolean {
  let persisted = false;
  return () => {
    if (persisted || !isRunOwner(messageId, token)) return false;
    persisted = true;
    return true;
  };
}
