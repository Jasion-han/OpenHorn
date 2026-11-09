import { expect, test } from "bun:test";
import { createScheduledRunLease } from "./scheduledRunLease";

function fixture(heartbeat: () => Promise<number | null>) {
  let now = 0;
  let next = 0;
  const callbacks = new Map<number, { at: number; run: () => void }>();
  const lease = createScheduledRunLease({
    durationMs: 120_000,
    acquiredAt: now,
    heartbeat,
    now: () => now,
    timers: {
      set(run, delay) {
        const id = ++next;
        callbacks.set(id, { at: now + delay, run });
        return id;
      },
      clear(id) {
        callbacks.delete(id as number);
      },
    },
  });
  return {
    lease,
    callbacks,
    advance(value: number) {
      now = value;
    },
  };
}

test("a rejected heartbeat aborts the worker and clears future heartbeats", async () => {
  const f = fixture(async () => null);
  expect(await f.lease.renew()).toBe(false);
  expect(f.lease.signal.aborted).toBe(true);
  expect(f.callbacks.size).toBe(0);
});

test("network failure retains only the original lease and then aborts", async () => {
  const f = fixture(async () => {
    throw new Error("synthetic offline");
  });
  f.advance(60_000);
  expect(await f.lease.renew()).toBe(true);
  f.advance(120_000);
  expect(f.lease.isLive()).toBe(false);
  expect(f.lease.signal.aborted).toBe(true);
  expect(f.callbacks.size).toBe(0);
});

test("a live heartbeat extends the deadline and a late response cannot revive an expired lease", async () => {
  let release!: (value: number) => void;
  let pending = false;
  const f = fixture(() =>
    pending
      ? new Promise<number>((resolve) => {
          release = resolve;
        })
      : Promise.resolve(120_000),
  );
  f.advance(60_000);
  expect(await f.lease.renew()).toBe(true);
  f.advance(150_000);
  expect(f.lease.isLive()).toBe(true);
  pending = true;
  const renewing = f.lease.renew();
  f.advance(181_000);
  release(120_000);
  expect(await renewing).toBe(false);
  expect(f.lease.signal.aborted).toBe(true);
});
