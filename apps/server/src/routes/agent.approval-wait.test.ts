import { expect, test } from "bun:test";
import { decideApprovalWait } from "./agent";

const MAX = 30 * 60 * 1000;

test("decideApprovalWait resolves when the approval is no longer pending", () => {
  expect(
    decideApprovalWait({
      approvalStatus: "approved",
      aborted: false,
      elapsedMs: 0,
      maxWaitMs: MAX,
    }),
  ).toBe("resolved");
  expect(
    decideApprovalWait({
      approvalStatus: "rejected",
      aborted: true,
      elapsedMs: MAX,
      maxWaitMs: MAX,
    }),
  ).toBe("resolved");
});

test("decideApprovalWait stops on abort when still pending", () => {
  expect(
    decideApprovalWait({ approvalStatus: "pending", aborted: true, elapsedMs: 0, maxWaitMs: MAX }),
  ).toBe("aborted");
  expect(
    decideApprovalWait({ approvalStatus: null, aborted: true, elapsedMs: 0, maxWaitMs: MAX }),
  ).toBe("aborted");
});

test("decideApprovalWait times out once max wait is reached", () => {
  expect(
    decideApprovalWait({
      approvalStatus: "pending",
      aborted: false,
      elapsedMs: MAX,
      maxWaitMs: MAX,
    }),
  ).toBe("timeout");
});

test("decideApprovalWait continues while pending, not aborted, under max wait", () => {
  expect(
    decideApprovalWait({
      approvalStatus: "pending",
      aborted: false,
      elapsedMs: 600,
      maxWaitMs: MAX,
    }),
  ).toBe("continue");
  expect(
    decideApprovalWait({ approvalStatus: null, aborted: false, elapsedMs: 0, maxWaitMs: MAX }),
  ).toBe("continue");
});
