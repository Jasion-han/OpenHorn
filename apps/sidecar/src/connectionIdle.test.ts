import { expect, test } from "bun:test";
import { shouldReapIdleConnection } from "./connectionIdle";

test("idle sockets expire while long-running and approval-waiting sockets stay connected", () => {
  const state = { lastActivityAt: 10, agentRuns: new Map(), pendingApprovals: new Map() };
  expect(shouldReapIdleConnection(state, 110, 100)).toBe(false);
  expect(shouldReapIdleConnection(state, 111, 100)).toBe(true);
  state.agentRuns.set("fixture", {});
  expect(shouldReapIdleConnection(state, 1000, 100)).toBe(false);
  state.agentRuns.clear();
  state.pendingApprovals.set("fixture", () => {});
  expect(shouldReapIdleConnection(state, 1000, 100)).toBe(false);
  state.pendingApprovals.clear();
  expect(shouldReapIdleConnection(state, 1000, 100)).toBe(true);
});
