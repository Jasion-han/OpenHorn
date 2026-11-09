/** A local monotonic deadline fences the worker even while the server is offline. */
export function createScheduledRunLease(options: {
  durationMs: number;
  acquiredAt: number;
  heartbeat: () => Promise<number | null>;
  now?: () => number;
  timers?: {
    set: (callback: () => void, delay: number) => unknown;
    clear: (handle: unknown) => void;
  };
}) {
  const now = options.now ?? (() => performance.now());
  const timers = options.timers ?? {
    set: (callback: () => void, delay: number) => setTimeout(callback, delay),
    clear: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
  const abort = new AbortController();
  let deadline = options.acquiredAt + options.durationMs;
  let heartbeatTimer: unknown;
  let expiryTimer: unknown;
  let stopped = false;
  let inFlight: Promise<boolean> | null = null;
  function stop() {
    stopped = true;
    timers.clear(heartbeatTimer);
    timers.clear(expiryTimer);
  }
  function lose() {
    if (abort.signal.aborted) return;
    stop();
    abort.abort();
  }
  function isLive(): boolean {
    if (now() >= deadline) lose();
    return !abort.signal.aborted;
  }
  function arm(durationMs: number) {
    timers.clear(heartbeatTimer);
    timers.clear(expiryTimer);
    if (stopped || !isLive()) return;
    heartbeatTimer = timers.set(() => void renew(), Math.min(30_000, durationMs / 3));
    expiryTimer = timers.set(lose, Math.max(0, deadline - now()));
  }
  function renew(): Promise<boolean> {
    if (stopped || !isLive()) return Promise.resolve(false);
    if (inFlight) return inFlight;
    timers.clear(heartbeatTimer);
    const sentAt = now();
    inFlight = (async () => {
      try {
        const duration = await options.heartbeat();
        if (!isLive() || stopped) return false;
        if (duration === null || !Number.isFinite(duration) || duration <= 0) {
          lose();
          return false;
        }
        // Start at request dispatch, not response arrival: slow/lost responses
        // must never let this client assume a longer lease than the server.
        deadline = sentAt + duration;
        arm(duration);
      } catch {
        // A network outage does not revoke a still-live lease. Retry briefly,
        // while the independent deadline timer will cancel an abandoned run.
        if (!stopped && isLive()) {
          heartbeatTimer = timers.set(() => void renew(), 5_000);
        }
      }
      return isLive();
    })().finally(() => {
      inFlight = null;
    });
    return inFlight;
  }
  if (!Number.isFinite(options.durationMs) || options.durationMs <= 0) lose();
  else arm(options.durationMs);
  return { signal: abort.signal, isLive, renew, stop };
}
