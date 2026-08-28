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
}

const FAILURE_THRESHOLD = 5;
const COOLDOWN_MS = 30_000;

const breakers = new Map<string, ChannelBreaker>();

export function recordChannelSuccess(channelId: string): void {
  const b = breakers.get(channelId);
  if (!b) return;
  b.state = "closed";
  b.consecutiveFailures = 0;
}

export function recordChannelFailure(channelId: string): void {
  let b = breakers.get(channelId);
  if (!b) {
    b = { state: "closed", consecutiveFailures: 0, lastFailureAt: 0, openedAt: 0 };
    breakers.set(channelId, b);
  }
  b.consecutiveFailures++;
  b.lastFailureAt = Date.now();
  if (b.consecutiveFailures >= FAILURE_THRESHOLD && b.state === "closed") {
    b.state = "open";
    b.openedAt = Date.now();
  }
  if (b.state === "half_open") {
    b.state = "open";
    b.openedAt = Date.now();
  }
}

export function isChannelAvailable(channelId: string): boolean {
  const b = breakers.get(channelId);
  if (!b) return true;
  if (b.state === "closed") return true;
  if (b.state === "open") {
    if (Date.now() - b.openedAt >= COOLDOWN_MS) {
      b.state = "half_open";
      return true;
    }
    return false;
  }
  // half_open: allow one probe
  return true;
}

export function getChannelBreakerState(channelId: string): CircuitState {
  return breakers.get(channelId)?.state ?? "closed";
}

export function resetAllBreakers(): void {
  breakers.clear();
}
