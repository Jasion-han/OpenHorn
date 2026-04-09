import { describe, expect, test } from "bun:test";
import {
  cancelAgentTask,
  respondAgentApproval,
  type AgentTaskActionApi,
} from "./agentTaskActions";

function makeRecordingApi(overrides: Partial<AgentTaskActionApi> = {}) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const api: AgentTaskActionApi = {
    respondApproval: async (...args) => {
      calls.push({ method: "respondApproval", args });
      return { ok: true };
    },
    cancel: async (...args) => {
      calls.push({ method: "cancel", args });
      return { ok: true };
    },
    ...overrides,
  };
  return { api, calls };
}

describe("respondAgentApproval", () => {
  test("posts approved status for tool_approval and does not call planApprovalAccepted", async () => {
    const { api, calls } = makeRecordingApi();
    let planApprovalCallbackInvoked = false;

    const result = await respondAgentApproval({
      api,
      approvalId: "appr-1",
      approvalType: "tool_approval",
      status: "approved",
      onPlanApprovalAccepted: async () => {
        planApprovalCallbackInvoked = true;
      },
    });

    expect(result).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("respondApproval");
    expect(calls[0]?.args).toEqual(["appr-1", { status: "approved" }]);
    expect(planApprovalCallbackInvoked).toBe(false);
  });

  test("posts rejected status for tool_approval", async () => {
    const { api, calls } = makeRecordingApi();
    const result = await respondAgentApproval({
      api,
      approvalId: "appr-2",
      approvalType: "tool_approval",
      status: "rejected",
    });
    expect(result).toEqual({ ok: true });
    expect(calls[0]?.args).toEqual(["appr-2", { status: "rejected" }]);
  });

  test("triggers onPlanApprovalAccepted when a plan_approval is approved", async () => {
    const { api, calls } = makeRecordingApi();
    let planApprovalCallbackInvoked = false;

    const result = await respondAgentApproval({
      api,
      approvalId: "appr-3",
      approvalType: "plan_approval",
      status: "approved",
      onPlanApprovalAccepted: async () => {
        planApprovalCallbackInvoked = true;
      },
    });

    expect(result).toEqual({ ok: true });
    expect(planApprovalCallbackInvoked).toBe(true);
    expect(calls).toHaveLength(1);
  });

  test("does NOT trigger onPlanApprovalAccepted when plan_approval is rejected", async () => {
    const { api } = makeRecordingApi();
    let planApprovalCallbackInvoked = false;

    const result = await respondAgentApproval({
      api,
      approvalId: "appr-4",
      approvalType: "plan_approval",
      status: "rejected",
      onPlanApprovalAccepted: async () => {
        planApprovalCallbackInvoked = true;
      },
    });

    expect(result).toEqual({ ok: true });
    expect(planApprovalCallbackInvoked).toBe(false);
  });

  test("returns ok:false with error message when respondApproval throws", async () => {
    const { api } = makeRecordingApi({
      respondApproval: async () => {
        throw new Error("network down");
      },
    });

    const result = await respondAgentApproval({
      api,
      approvalId: "appr-5",
      approvalType: "tool_approval",
      status: "approved",
    });

    expect(result).toEqual({ ok: false, error: "network down" });
  });

  test("returns ok:false when onPlanApprovalAccepted throws after the response is persisted", async () => {
    const { api, calls } = makeRecordingApi();

    const result = await respondAgentApproval({
      api,
      approvalId: "appr-6",
      approvalType: "plan_approval",
      status: "approved",
      onPlanApprovalAccepted: async () => {
        throw new Error("execute failed");
      },
    });

    expect(result).toEqual({ ok: false, error: "execute failed" });
    // The approval was still posted, so the user is not stuck on a stale
    // pending approval — only the follow-up execution is reported as failed.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("respondApproval");
  });
});

describe("cancelAgentTask", () => {
  test("invokes onLocalAbort before calling api.cancel", async () => {
    const order: string[] = [];
    const { api } = makeRecordingApi({
      cancel: async () => {
        order.push("cancel");
      },
    });

    const result = await cancelAgentTask({
      api,
      taskId: "task-1",
      onLocalAbort: () => {
        order.push("abort");
      },
    });

    expect(result).toEqual({ ok: true });
    expect(order).toEqual(["abort", "cancel"]);
  });

  test("still aborts locally even if api.cancel rejects", async () => {
    let aborted = false;
    const { api } = makeRecordingApi({
      cancel: async () => {
        throw new Error("server unreachable");
      },
    });

    const result = await cancelAgentTask({
      api,
      taskId: "task-2",
      onLocalAbort: () => {
        aborted = true;
      },
    });

    expect(aborted).toBe(true);
    expect(result).toEqual({ ok: false, error: "server unreachable" });
  });
});
