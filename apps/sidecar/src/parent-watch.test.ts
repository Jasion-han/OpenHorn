import { describe, expect, test } from "bun:test";
import { isParentWatchEnabled, parentIsGone, startParentWatchdog } from "./parent-watch";

describe("isParentWatchEnabled", () => {
  test("enabled only when OPENHORN_PARENT_WATCH=1", () => {
    expect(isParentWatchEnabled({ OPENHORN_PARENT_WATCH: "1" })).toBe(true);
    expect(isParentWatchEnabled({ OPENHORN_PARENT_WATCH: " 1 " })).toBe(true);
    expect(isParentWatchEnabled({})).toBe(false);
    expect(isParentWatchEnabled({ OPENHORN_PARENT_WATCH: "0" })).toBe(false);
    expect(isParentWatchEnabled({ OPENHORN_PARENT_WATCH: "" })).toBe(false);
    expect(isParentWatchEnabled({ OPENHORN_HANDSHAKE_TOKEN: "abc" })).toBe(false);
  });
});

describe("parentIsGone", () => {
  test("live parent with unchanged ppid is not gone", () => {
    expect(parentIsGone(4242, { currentPpid: 4242, probeErrorCode: null })).toBe(false);
  });
  test("ESRCH probe means the parent is gone even with a stale cached ppid", () => {
    expect(parentIsGone(4242, { currentPpid: 4242, probeErrorCode: "ESRCH" })).toBe(true);
  });
  test("a changed ppid (reparented to launchd/init or a subreaper) means gone", () => {
    expect(parentIsGone(4242, { currentPpid: 1, probeErrorCode: null })).toBe(true);
    expect(parentIsGone(4242, { currentPpid: 777, probeErrorCode: null })).toBe(true);
  });
  test("ambiguous probe errors are treated as alive", () => {
    expect(parentIsGone(4242, { currentPpid: 4242, probeErrorCode: "EPERM" })).toBe(false);
    expect(parentIsGone(4242, { currentPpid: 4242, probeErrorCode: "UNKNOWN" })).toBe(false);
  });
  test("an orphaned start (ppid <= 1) or invalid baseline never triggers", () => {
    expect(parentIsGone(1, { currentPpid: 1, probeErrorCode: null })).toBe(false);
    expect(parentIsGone(1, { currentPpid: 500, probeErrorCode: "ESRCH" })).toBe(false);
    expect(parentIsGone(0, { currentPpid: 1, probeErrorCode: "ESRCH" })).toBe(false);
    expect(parentIsGone(Number.NaN, { currentPpid: 1, probeErrorCode: "ESRCH" })).toBe(false);
    expect(parentIsGone(4242, { currentPpid: Number.NaN, probeErrorCode: null })).toBe(false);
  });
});

describe("startParentWatchdog", () => {
  test("fires once after the parent pid stops existing", async () => {
    let alive = true;
    let calls = 0;
    const stop = startParentWatchdog(() => calls++, {
      readPpid: () => 4242,
      probe: () => (alive ? null : "ESRCH"),
      intervalMs: 5,
    });
    await Bun.sleep(20);
    expect(calls).toBe(0);
    alive = false;
    await Bun.sleep(30);
    expect(calls).toBe(1);
    stop();
  });
  test("stop() prevents firing", async () => {
    let calls = 0;
    const stop = startParentWatchdog(() => calls++, {
      readPpid: () => 4242,
      probe: () => "ESRCH",
      intervalMs: 5,
    });
    stop();
    await Bun.sleep(20);
    expect(calls).toBe(0);
  });
  test("the real probe sees this test process's parent as alive", async () => {
    let calls = 0;
    const stop = startParentWatchdog(() => calls++, { intervalMs: 5 });
    await Bun.sleep(30);
    expect(calls).toBe(0);
    stop();
  });
});
