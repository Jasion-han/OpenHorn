import { describe, expect, test } from "bun:test";
import {
  createBackendStatusStore,
  isServerReady,
  type ProbeResult,
  reconnectDelay,
  serverConnectionNotice,
} from "./backendStatusStore";

function harness(probeResults: ProbeResult[] = []) {
  const timers: Array<{ id: number; fn: () => void; ms: number }> = [];
  let seq = 0;
  let probes = 0;
  const store = createBackendStatusStore({
    probe: async () => {
      probes += 1;
      return probeResults.shift() ?? { ok: true };
    },
    setTimer: (fn, ms) => {
      seq += 1;
      timers.push({ id: seq, fn, ms });
      return seq;
    },
    clearTimer: (handle) => {
      const index = timers.findIndex((timer) => timer.id === handle);
      if (index >= 0) timers.splice(index, 1);
    },
    now: () => 1,
  });
  const fireTimer = async () => {
    const timer = timers.shift();
    if (!timer) throw new Error("no timer pending");
    timer.fn();
    await flush();
  };
  return { store, timers, fireTimer, probes: () => probes };
}

async function flush() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("connection helpers", () => {
  test("backoff grows and caps", () => {
    expect(reconnectDelay(0)).toBe(1_000);
    expect(reconnectDelay(1)).toBe(2_000);
    expect(reconnectDelay(5)).toBe(30_000);
    expect(reconnectDelay(50)).toBe(30_000);
  });

  test("ready only when reachable and loaded", () => {
    expect(isServerReady({ status: "ok", loaded: true })).toBe(true);
    expect(isServerReady({ status: "ok", loaded: false })).toBe(false);
    expect(isServerReady({ status: "unknown", loaded: false })).toBe(false);
    expect(isServerReady({ status: "down", loaded: true })).toBe(false);
    expect(serverConnectionNotice({ status: "unknown", loaded: false })).toBe("connecting");
    expect(serverConnectionNotice({ status: "down", loaded: true })).toBe("unavailable");
    expect(serverConnectionNotice({ status: "ok", loaded: true })).toBe(null);
  });
});

describe("backend status store", () => {
  test("is a passive recorder until started", async () => {
    const { store, timers } = harness();
    store.getState().markDown("Failed to fetch");
    store.getState().markUp();
    await flush();
    expect(timers).toHaveLength(0);
    expect(store.getState().loaded).toBe(false);
    expect(store.getState().status).toBe("ok");
  });

  test("a clean start loads once and does not announce a reconnect", async () => {
    const { store, timers } = harness();
    let loads = 0;
    let reconnects = 0;
    const ok = await store.getState().start({
      loader: async () => {
        loads += 1;
        store.getState().markUp();
        store.getState().markUp();
      },
      onReconnected: () => {
        reconnects += 1;
      },
    });
    await flush();
    expect(ok).toBe(true);
    expect(loads).toBe(1);
    expect(reconnects).toBe(0);
    expect(store.getState()).toMatchObject({ status: "ok", loaded: true, loading: false });
    expect(timers).toHaveLength(0);

    // Later successful requests are not a cue to reload.
    store.getState().markUp();
    await flush();
    expect(loads).toBe(1);
  });

  test("offline start stays unloaded, then the first probe reloads everything once", async () => {
    const { store, timers, fireTimer } = harness([{ ok: true }]);
    let serverUp = false;
    let loads = 0;
    let reconnects = 0;
    const ok = await store.getState().start({
      loader: async () => {
        loads += 1;
        if (serverUp) store.getState().markUp();
        else store.getState().markDown("Failed to fetch");
      },
      onReconnected: () => {
        reconnects += 1;
      },
    });
    expect(ok).toBe(false);
    expect(store.getState()).toMatchObject({ status: "down", loaded: false });
    expect(timers).toHaveLength(1);
    expect(timers[0].ms).toBe(1_000);

    serverUp = true;
    await fireTimer();
    expect(loads).toBe(2);
    expect(reconnects).toBe(1);
    expect(store.getState()).toMatchObject({ status: "ok", loaded: true, reconnectAttempt: 0 });
    expect(timers).toHaveLength(0);
  });

  test("probes back off while the server stays down", async () => {
    const { store, timers, fireTimer, probes } = harness([
      { ok: false, message: "Failed to fetch" },
      { ok: false, message: "Failed to fetch" },
    ]);
    await store.getState().start({
      loader: async () => store.getState().markDown("Failed to fetch"),
    });
    expect(timers[0].ms).toBe(1_000);
    await fireTimer();
    expect(timers[0].ms).toBe(2_000);
    await fireTimer();
    expect(timers[0].ms).toBe(5_000);
    expect(probes()).toBe(2);
    expect(timers).toHaveLength(1);
  });

  test("any sign of life after an outage triggers exactly one full reload", async () => {
    const { store } = harness();
    let loads = 0;
    let reconnects = 0;
    let release: () => void = () => {};
    let gate: Promise<void> = Promise.resolve();
    await store.getState().start({
      loader: async () => {
        loads += 1;
        await gate;
        store.getState().markUp();
      },
      onReconnected: () => {
        reconnects += 1;
      },
    });
    expect(loads).toBe(1);

    gate = new Promise((resolve) => {
      release = resolve;
    });
    store.getState().markDown("Failed to fetch");
    // An unrelated request succeeds: reload starts. More successes while it
    // runs must not stack a second load.
    store.getState().markUp();
    store.getState().markUp();
    store.getState().markUp();
    release();
    await flush();
    expect(loads).toBe(2);
    expect(reconnects).toBe(1);
    expect(store.getState().loaded).toBe(true);
  });

  test("a load that saw a network failure is not counted as loaded", async () => {
    const { store, timers } = harness();
    let first = true;
    const ok = await store.getState().start({
      loader: async () => {
        if (first) {
          first = false;
          // One request failed, a later one succeeded: still a partial load.
          store.getState().markDown("Failed to fetch");
          store.getState().markUp();
        }
      },
    });
    expect(ok).toBe(false);
    expect(store.getState().loaded).toBe(false);
    expect(timers).toHaveLength(1);
  });

  test("manual retry cancels the pending probe and resolves after the full load", async () => {
    const { store, timers } = harness([{ ok: true }]);
    let serverUp = false;
    let loads = 0;
    await store.getState().start({
      loader: async () => {
        loads += 1;
        if (serverUp) store.getState().markUp();
        else store.getState().markDown("Failed to fetch");
      },
    });
    expect(timers).toHaveLength(1);

    serverUp = true;
    const ok = await store.getState().retry();
    expect(ok).toBe(true);
    expect(loads).toBe(2);
    expect(timers).toHaveLength(0);
    expect(isServerReady(store.getState())).toBe(true);
  });

  test("manual retry against a dead server reports failure and keeps probing", async () => {
    const { store, timers } = harness([{ ok: false, message: "Failed to fetch" }]);
    await store.getState().start({
      loader: async () => store.getState().markDown("Failed to fetch"),
    });
    const ok = await store.getState().retry();
    expect(ok).toBe(false);
    expect(store.getState().status).toBe("down");
    expect(timers).toHaveLength(1);
  });

  test("a manual retry while an automatic probe is running shares one reload", async () => {
    let resolveProbe: (result: ProbeResult) => void = () => {};
    const timers: Array<() => void> = [];
    let probes = 0;
    const store = createBackendStatusStore({
      probe: () => {
        probes += 1;
        if (probes === 1) {
          return new Promise((resolve) => {
            resolveProbe = resolve;
          });
        }
        return Promise.resolve({ ok: true });
      },
      setTimer: (fn) => {
        timers.push(fn);
        return timers.length;
      },
      clearTimer: () => {},
      now: () => 1,
    });
    let serverUp = false;
    let loads = 0;
    await store.getState().start({
      loader: async () => {
        loads += 1;
        if (serverUp) store.getState().markUp();
        else store.getState().markDown("Failed to fetch");
      },
    });
    serverUp = true;
    // The automatic probe is in flight (unresolved) when the user hits Retry.
    timers.shift()?.();
    const retried = store.getState().retry();
    resolveProbe({ ok: true });
    expect(await retried).toBe(true);
    await flush();
    expect(loads).toBe(2);
    expect(isServerReady(store.getState())).toBe(true);
  });

  test("stop cancels the pending probe and detaches the loader", async () => {
    const { store, timers } = harness();
    let loads = 0;
    await store.getState().start({
      loader: async () => {
        loads += 1;
        store.getState().markDown("Failed to fetch");
      },
    });
    expect(timers).toHaveLength(1);
    store.getState().stop();
    expect(timers).toHaveLength(0);
    store.getState().markUp();
    await flush();
    expect(loads).toBe(1);
  });
});

test("reloading cached required data keeps the UI write gate closed", () => {
  expect(isServerReady({ status: "ok", loaded: true, loading: true })).toBe(false);
  expect(serverConnectionNotice({ status: "ok", loaded: true, loading: true })).toBe("connecting");
});
