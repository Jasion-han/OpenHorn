import { describe, expect, test } from "bun:test";
import { buildTaskCardSummary, selectTaskFailure, selectTaskReplyText } from "./agentTaskMessage";
import type { AgentTaskDetail, AgentTaskRecord } from "./agentTaskService";

function makeDetail(overrides: {
  status: AgentTaskRecord["status"];
  previewText?: string | null;
}): AgentTaskDetail {
  const task: AgentTaskRecord = {
    id: "task-1",
    userId: "user-1",
    conversationId: null,
    channelId: null,
    modelId: null,
    title: "Test task",
    goal: "Goal",
    attachments: [],
    complexity: "standard",
    uxMode: "compact",
    requiresPlanApproval: false,
    autoStart: true,
    status: overrides.status,
    insight:
      overrides.previewText !== undefined
        ? {
            highlight: null,
            summary: overrides.previewText,
            previewKind: overrides.previewText ? "summary" : null,
            previewText: overrides.previewText,
            runCount: 1,
            latestRunStatus: null,
            latestRunPhase: null,
            latestApprovalType: null,
            latestApprovalStatus: null,
            hasFinalResult: false,
          }
        : null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  return {
    task,
    runs: [],
    planSteps: [],
    approvals: [],
    artifacts: [],
    events: [],
    runtime: null,
  };
}

describe("buildTaskCardSummary", () => {
  test("returns the real previewText when available", () => {
    const detail = makeDetail({ status: "completed", previewText: "real summary text" });
    expect(buildTaskCardSummary(detail)).toBe("real summary text");
  });

  test("trims whitespace from previewText", () => {
    const detail = makeDetail({ status: "completed", previewText: "  hello  " });
    expect(buildTaskCardSummary(detail)).toBe("hello");
  });

  test("returns empty string when insight is null (never invents a placeholder)", () => {
    const detail = makeDetail({ status: "running" });
    expect(buildTaskCardSummary(detail)).toBe("");
  });

  test("returns empty string when previewText is null", () => {
    const detail = makeDetail({ status: "running", previewText: null });
    expect(buildTaskCardSummary(detail)).toBe("");
  });

  test("returns empty string when previewText is empty", () => {
    const detail = makeDetail({ status: "planning", previewText: "" });
    expect(buildTaskCardSummary(detail)).toBe("");
  });

  test("returns empty string for every status when no real preview is available", () => {
    const statuses: AgentTaskRecord["status"][] = [
      "draft",
      "planning",
      "awaiting_approval",
      "running",
      "completed",
      "failed",
      "cancelled",
    ];
    for (const status of statuses) {
      const detail = makeDetail({ status });
      expect(buildTaskCardSummary(detail)).toBe("");
    }
  });

  test("never returns invented Chinese placeholder strings", () => {
    const detail = makeDetail({ status: "planning" });
    const result = buildTaskCardSummary(detail);
    // Sanity check: should not contain any of the previously hard-coded strings.
    expect(result).not.toContain("正在");
    expect(result).not.toContain("我会");
    expect(result).not.toContain("我先");
    expect(result).not.toContain("任务已");
  });
});

describe("selectTaskReplyText", () => {
  const long = "x".repeat(5000);

  test("returns the full final_result of the latest execution run, never clipped", () => {
    const runs = [
      { id: "exec-2", phase: "execution" },
      { id: "plan-1", phase: "planning" },
      { id: "exec-1", phase: "execution" },
    ];
    const artifacts = [
      { runId: "exec-1", type: "final_result", content: "older answer" },
      { runId: "exec-2", type: "execution_summary", content: "summary" },
      { runId: "exec-2", type: "final_result", content: `  ${long}  ` },
    ];
    expect(selectTaskReplyText(runs, artifacts)).toBe(long);
  });

  test("falls back to the newest final_result when the latest run produced none", () => {
    const runs = [
      { id: "exec-2", phase: "execution" },
      { id: "exec-1", phase: "execution" },
    ];
    const artifacts = [{ runId: "exec-1", type: "final_result", content: "older answer" }];
    expect(selectTaskReplyText(runs, artifacts)).toBe("older answer");
  });

  test("is empty without a final_result", () => {
    expect(selectTaskReplyText([{ id: "p", phase: "planning" }], [])).toBe("");
  });
});

describe("selectTaskFailure", () => {
  const runs = [
    { id: "exec-2", phase: "execution", error: " boom " },
    { id: "exec-1", phase: "execution", error: "old" },
  ];

  test("returns the latest execution error of a failed task", () => {
    expect(selectTaskFailure("failed", runs)).toBe("boom");
  });

  test("is undefined for tasks that did not fail", () => {
    expect(selectTaskFailure("completed", runs)).toBeUndefined();
    expect(selectTaskFailure("failed", [{ id: "p", phase: "planning", error: null }])).toBe(
      undefined,
    );
  });
});
