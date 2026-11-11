import { describe, expect, test } from "bun:test";
import {
  createWelcomeSuggestionStore,
  STALE_RECHECK_DELAYS_MS,
  type WelcomeSuggestionsResult,
} from "./welcomeSuggestionStore";

function harness(results: WelcomeSuggestionsResult[]) {
  const timers: Array<{ fn: () => void; ms: number }> = [];
  let reads = 0;
  const store = createWelcomeSuggestionStore({
    fetchSuggestions: async () => {
      reads += 1;
      return results.shift() ?? { items: [], stale: false };
    },
    setTimer: (fn, ms) => {
      timers.push({ fn, ms });
      return timers.length;
    },
  });
  return { store, timers, reads: () => reads };
}

async function flush() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe("welcome suggestion store", () => {
  test("an offline read keeps the defaults, a later load picks up the server set", async () => {
    const { store } = harness([
      { items: [], stale: false },
      { items: ["a", "b"], stale: false },
    ]);
    await store.getState().load();
    expect(store.getState().items).toEqual([]);
    await store.getState().load();
    expect(store.getState().items).toEqual(["a", "b"]);
  });

  test("an empty read never wipes a set already shown", async () => {
    const { store } = harness([
      { items: ["a"], stale: false },
      { items: [], stale: false },
    ]);
    await store.getState().load();
    await store.getState().load();
    expect(store.getState().items).toEqual(["a"]);
  });

  test("concurrent loads share one request", async () => {
    const { store, reads } = harness([{ items: ["a"], stale: false }]);
    await Promise.all([store.getState().load(), store.getState().load()]);
    expect(reads()).toBe(1);
  });

  test("a stale set schedules one recheck series, however many loads report it", async () => {
    const { store, timers } = harness([
      { items: ["old"], stale: true },
      { items: ["old"], stale: true },
      { items: ["new"], stale: false },
    ]);
    await store.getState().load();
    await store.getState().load();
    expect(timers.map((timer) => timer.ms)).toEqual([...STALE_RECHECK_DELAYS_MS]);
    timers[0].fn();
    await flush();
    expect(store.getState().items).toEqual(["new"]);
  });
});

test("reset ignores old responses and does not clear a newer in-flight request", async () => {
  const pending: Array<(result: WelcomeSuggestionsResult) => void> = [];
  const store = createWelcomeSuggestionStore({
    fetchSuggestions: () => new Promise((done) => pending.push(done)),
  });
  const oldLoad = store.getState().load();
  store.getState().reset();
  const newLoad = store.getState().load();
  pending[0]({ items: ["old identity"], stale: true });
  await oldLoad;
  expect(store.getState().items).toEqual([]);
  const duplicate = store.getState().load();
  expect(pending.length).toBe(2);
  pending[1]({ items: ["new identity"], stale: false });
  await Promise.all([newLoad, duplicate]);
  expect(store.getState().items).toEqual(["new identity"]);
});

test("reset cancels rechecks and a previously queued callback stays inert", async () => {
  const timers: Array<() => void> = [],
    cancelled: unknown[] = [];
  let calls = 0;
  const store = createWelcomeSuggestionStore({
    fetchSuggestions: async () => {
      calls++;
      return { items: ["cached"], stale: true };
    },
    setTimer: (fn) => {
      timers.push(fn);
      return timers.length;
    },
    clearTimer: (handle) => {
      cancelled.push(handle);
    },
  });
  await store.getState().load();
  store.getState().reset();
  for (const fn of timers) fn();
  await flush();
  expect(store.getState().items).toEqual([]);
  expect(calls).toBe(1);
  expect(cancelled).toEqual([1, 2]);
  await store.getState().load();
  expect(timers.length).toBe(4);
});
