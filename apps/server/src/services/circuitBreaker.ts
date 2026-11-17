/**
 * Per-channel circuit breaker (in-memory, no persistence).
 *
 * When a channel accumulates {@link FAILURE_THRESHOLD} consecutive retryable
 * failures it trips open and rejects further requests for {@link COOLDOWN_MS}.
 * After the cooldown a single probe request is allowed through (half_open);
 * success closes the breaker, failure re-opens it.
 */

type CircuitState = "closed" | "open" | "half_open";

interface ChannelBreaker {
  state: CircuitState;
  consecutiveFailures: number;
  lastFailureAt: number;
  openedAt: number;
  probeStartedAt: number;
  probeId: number | null;
}

const FAILURE_THRESHOLD = 5;
const COOLDOWN_MS = 30_000;
export const CHANNEL_PROBE_TIMEOUT_MS = 120_000;

const breakers = new Map<string, ChannelBreaker>();
let nextProbeId = 0;

function reopen(b: ChannelBreaker, now: number): void {
  b.state = "open";
  b.openedAt = now;
  b.probeId = null;
}

export function recordChannelSuccess(channelId: string): void {
  const b = breakers.get(channelId);
  if (!b) return;
  b.state = "closed";
  b.consecutiveFailures = 0;
  b.probeId = null;
}

export function recordChannelFailure(channelId: string): void {
  let b = breakers.get(channelId);
  if (!b) {
    b = {
      state: "closed",
      consecutiveFailures: 0,
      lastFailureAt: 0,
      openedAt: 0,
      probeStartedAt: 0,
      probeId: null,
    };
    breakers.set(channelId, b);
  }
  b.consecutiveFailures++;
  b.lastFailureAt = Date.now();
  if (b.consecutiveFailures >= FAILURE_THRESHOLD && b.state === "closed") {
    reopen(b, Date.now());
  }
  if (b.state === "half_open") {
    reopen(b, Date.now());
  }
}

/** Acquires the sole recovery probe; callers must use the returned channel. */
export function isChannelAvailable(channelId: string): boolean {
  const b = breakers.get(channelId);
  if (!b) return true;
  if (b.state === "closed") return true;
  const now = Date.now();
  if (b.state === "open") {
    if (now - b.openedAt >= COOLDOWN_MS) {
      b.state = "half_open";
      b.probeStartedAt = now;
      b.probeId = ++nextProbeId;
      return true;
    }
    return false;
  }
  // A crashed client or a local preflight failure may never report an outcome.
  // Cool down again after its lease instead of either blocking forever or
  // immediately admitting another request while the first may still run.
  if (now - b.probeStartedAt >= CHANNEL_PROBE_TIMEOUT_MS) reopen(b, now);
  return false;
}

export function getChannelProbe(channelId: string): { id: number; expiresAt: number } | null {
  const b = breakers.get(channelId);
  if (b?.state !== "half_open" || b.probeId === null) return null;
  const expiresAt = b.probeStartedAt + CHANNEL_PROBE_TIMEOUT_MS;
  if (Date.now() >= expiresAt) {
    reopen(b, Date.now());
    return null;
  }
  return { id: b.probeId, expiresAt };
}

/** Only the exact outstanding probe may settle an out-of-process result. */
export function settleChannelProbe(
  channelId: string,
  probeId: number,
  outcome: "success" | "abandoned",
): void {
  const b = breakers.get(channelId);
  if (b?.state !== "half_open" || b.probeId !== probeId) return;
  if (outcome === "success" && Date.now() - b.probeStartedAt < CHANNEL_PROBE_TIMEOUT_MS) {
    recordChannelSuccess(channelId);
  } else {
    reopen(b, Date.now());
  }
}

export function getChannelBreakerState(channelId: string): CircuitState {
  return breakers.get(channelId)?.state ?? "closed";
}

export function resetAllBreakers(): void {
  breakers.clear();
}
