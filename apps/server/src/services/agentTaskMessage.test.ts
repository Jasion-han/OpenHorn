import { describe, expect, test } from "bun:test";
import { buildTaskMessageSummary } from "./agentTaskMessage";
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
    createdAt: new Date(),
    updatedAt: new Date(),
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

describe("buildTaskMessageSummary", () => {
  test("returns the real previewText when available", () => {
    const detail = makeDetail({ status: "completed", previewText: "real summary text" });
    expect(buildTaskMessageSummary(detail)).toBe("real summary text");
  });

  test("trims whitespace from previewText", () => {
    const detail = makeDetail({ status: "completed", previewText: "  hello  " });
    expect(buildTaskMessageSummary(detail)).toBe("hello");
  });

  test("returns empty string when insight is null (never invents a placeholder)", () => {
    const detail = makeDetail({ status: "running" });
    expect(buildTaskMessageSummary(detail)).toBe("");
  });

  test("returns empty string when previewText is null", () => {
    const detail = makeDetail({ status: "running", previewText: null });
    expect(buildTaskMessageSummary(detail)).toBe("");
  });

  test("returns empty string when previewText is empty", () => {
    const detail = makeDetail({ status: "planning", previewText: "" });
    expect(buildTaskMessageSummary(detail)).toBe("");
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
      expect(buildTaskMessageSummary(detail)).toBe("");
    }
  });

  test("never returns invented Chinese placeholder strings", () => {
    const detail = makeDetail({ status: "planning" });
    const result = buildTaskMessageSummary(detail);
    // Sanity check: should not contain any of the previously hard-coded strings.
    expect(result).not.toContain("正在");
    expect(result).not.toContain("我会");
    expect(result).not.toContain("我先");
    expect(result).not.toContain("任务已");
  });
});
