import { describe, expect, test } from "bun:test";
import { claimRunOwnership, createRunPersistGuard, isRunOwner } from "./sidecarRunOwnership";

// The registry is module-level (shared across runs on purpose), so every test
// uses its own message ids to stay independent.

describe("claimRunOwnership / isRunOwner", () => {
  test("a new claim disowns the previous run's token", () => {
    const oldToken = claimRunOwnership(["own-1"]);
    const newToken = claimRunOwnership(["own-1"]);
    expect(isRunOwner("own-1", oldToken)).toBe(false);
    expect(isRunOwner("own-1", newToken)).toBe(true);
  });

  test("the same run stays the owner across its own event stream", () => {
    const token = claimRunOwnership(["own-2"]);
    // delta → delta → done: every callback re-checks ownership and passes.
    expect(isRunOwner("own-2", token)).toBe(true);
    expect(isRunOwner("own-2", token)).toBe(true);
    expect(isRunOwner("own-2", token)).toBe(true);
  });

  test("claims cover every provided id and skip undefined", () => {
    const token = claimRunOwnership(["own-3a", undefined, "own-3b"]);
    expect(isRunOwner("own-3a", token)).toBe(true);
    expect(isRunOwner("own-3b", token)).toBe(true);
  });

  test("an id that was never claimed has no owner", () => {
    const token = claimRunOwnership(["own-4"]);
    expect(isRunOwner("own-4-other", token)).toBe(false);
  });
});

describe("regenerate interleave scenario", () => {
  test("old run's late deltas are dropped after the new run claims the message", () => {
    // Mirrors the hook's onEvent delta path: append only while owning.
    let content = "";
    const applyDelta = (token: symbol, delta: string) => {
      if (!isRunOwner("interleave-1", token)) return;
      content += delta;
    };

    const oldRun = claimRunOwnership(["interleave-1"]);
    applyDelta(oldRun, "before ");

    // User clicks regenerate: retry clears the bubble and starts a new run
    // bound to the SAME assistant message id.
    content = "";
    const newRun = claimRunOwnership(["interleave-1"]);

    // In-flight events from the cancelled old run keep arriving, interleaved
    // with the new run's stream — exactly the corruption scenario.
    applyDelta(oldRun, "old-A ");
    applyDelta(newRun, "new-1 ");
    applyDelta(oldRun, "old-B ");
    applyDelta(newRun, "new-2");

    expect(content).toBe("new-1 new-2");
  });

  test("old run's done cannot flip state owned by the new run", () => {
    let isBusy = true;
    const onDone = (token: symbol) => {
      if (!isRunOwner("interleave-2", token)) return;
      isBusy = false;
    };

    const oldRun = claimRunOwnership(["interleave-2"]);
    claimRunOwnership(["interleave-2"]); // new run takes over, still busy
    onDone(oldRun);
    expect(isBusy).toBe(true);
  });
});

describe("createRunPersistGuard", () => {
  test("the same run persists at most once", () => {
    const token = claimRunOwnership(["persist-1"]);
    const shouldPersist = createRunPersistGuard("persist-1", token);
    expect(shouldPersist()).toBe(true); // done path persists
    expect(shouldPersist()).toBe(false); // a late error event must not persist again
  });

  test("a superseded run can no longer persist; the new run persists once", () => {
    const oldToken = claimRunOwnership(["persist-2"]);
    const oldGuard = createRunPersistGuard("persist-2", oldToken);

    const newToken = claimRunOwnership(["persist-2"]);
    const newGuard = createRunPersistGuard("persist-2", newToken);

    expect(oldGuard()).toBe(false); // old run's done fires after the retry started
    expect(newGuard()).toBe(true);
    expect(newGuard()).toBe(false);
    expect(oldGuard()).toBe(false); // and its error path afterwards
  });

  test("guards are independent per run (per-closure, not hook-level)", () => {
    const tokenA = claimRunOwnership(["persist-3a"]);
    const tokenB = claimRunOwnership(["persist-3b"]);
    const guardA = createRunPersistGuard("persist-3a", tokenA);
    const guardB = createRunPersistGuard("persist-3b", tokenB);
    expect(guardA()).toBe(true);
    // Consuming run A's guard must not consume run B's.
    expect(guardB()).toBe(true);
  });
});
