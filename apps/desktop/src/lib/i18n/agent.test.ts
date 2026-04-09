import { describe, expect, test } from "bun:test";
import {
  agentApprovalStatusLabels,
  agentApprovalTypeLabels,
  agentErrorLabels,
  agentPlanStepStatusLabels,
  agentRuntimeIssueLabels,
  agentStatusLabels,
  getAgentActionLabel,
  getAgentApprovalStatusLabel,
  getAgentApprovalTypeLabel,
  getAgentErrorLabel,
  getAgentPlanStepStatusLabel,
  getAgentRuntimeIssueLabel,
  getAgentStatusLabel,
} from "./agent";
import type { ApiAgentTaskStatus, ApiProviderErrorKind } from "../../types/chat";

describe("agent i18n dictionary", () => {
  test("covers every task status enum value", () => {
    const allStatuses: ApiAgentTaskStatus[] = [
      "draft",
      "planning",
      "awaiting_approval",
      "running",
      "completed",
      "failed",
      "cancelled",
    ];
    for (const status of allStatuses) {
      const label = getAgentStatusLabel(status);
      expect(typeof label).toBe("string");
      expect(label).toBe(agentStatusLabels[status]);
    }
  });

  test("covers every provider error kind", () => {
    const allKinds: ApiProviderErrorKind[] = [
      "quota_exhausted",
      "ssl_handshake_failed",
      "gateway_failed",
      "auth_failed",
      "timeout",
      "protocol_incompatible",
      "model_not_found",
      "request_failed",
      "server_failed",
      "network_failed",
      "unknown",
    ];
    for (const kind of allKinds) {
      const label = getAgentErrorLabel(kind);
      expect(label).toBe(agentErrorLabels[kind]);
    }
  });

  test("appends retry hint when retryable is true", () => {
    const base = getAgentErrorLabel("timeout", false);
    const retryable = getAgentErrorLabel("timeout", true);
    expect(base).toBe(agentErrorLabels.timeout);
    expect(retryable).toBe(`${agentErrorLabels.timeout}，可稍后重试`);
  });

  test("returns null for null/undefined inputs instead of falling back", () => {
    expect(getAgentStatusLabel(null)).toBe(null);
    expect(getAgentStatusLabel(undefined)).toBe(null);
    expect(getAgentErrorLabel(null)).toBe(null);
    expect(getAgentErrorLabel(undefined)).toBe(null);
    expect(getAgentPlanStepStatusLabel(null)).toBe(null);
    expect(getAgentApprovalTypeLabel(null)).toBe(null);
    expect(getAgentApprovalStatusLabel(null)).toBe(null);
    expect(getAgentRuntimeIssueLabel(null)).toBe(null);
  });

  test("plan step statuses are all covered", () => {
    const statuses: Array<keyof typeof agentPlanStepStatusLabels> = [
      "pending",
      "ready",
      "running",
      "completed",
      "failed",
    ];
    for (const status of statuses) {
      expect(getAgentPlanStepStatusLabel(status)).toBe(agentPlanStepStatusLabels[status]);
    }
  });

  test("approval type / status dictionaries are complete", () => {
    expect(getAgentApprovalTypeLabel("plan_approval")).toBe(
      agentApprovalTypeLabels.plan_approval,
    );
    expect(getAgentApprovalTypeLabel("tool_approval")).toBe(
      agentApprovalTypeLabels.tool_approval,
    );
    expect(getAgentApprovalStatusLabel("pending")).toBe(agentApprovalStatusLabels.pending);
    expect(getAgentApprovalStatusLabel("approved")).toBe(agentApprovalStatusLabels.approved);
    expect(getAgentApprovalStatusLabel("rejected")).toBe(agentApprovalStatusLabels.rejected);
  });

  test("action labels are all defined non-empty strings", () => {
    const actions = [
      "approve",
      "reject",
      "allow",
      "deny",
      "stop",
      "retry",
      "continueRun",
      "continueAsk",
      "rollback",
      "viewDetails",
    ] as const;
    for (const action of actions) {
      const label = getAgentActionLabel(action);
      expect(typeof label).toBe("string");
      expect(label.length > 0).toBe(true);
    }
  });

  test("runtime issue dictionary covers the current server-side keys", () => {
    const keys: Array<keyof typeof agentRuntimeIssueLabels> = [
      "live_search_timeout",
      "live_search_failed",
      "live_search_empty",
      "research_failed",
    ];
    for (const key of keys) {
      expect(getAgentRuntimeIssueLabel(key)).toBe(agentRuntimeIssueLabels[key]);
    }
  });
});
