import { describe, expect, test } from "bun:test";
import type { ApiAgentTaskStatus, ApiProviderErrorKind } from "../../types/chat";
import {
  agentPanelLabels,
  getAgentActionLabel,
  getAgentErrorLabel,
  getAgentPlanStepStatusLabel,
  getAgentRuntimeIssueLabel,
  getAgentStatusLabel,
} from "./agent";

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
      expect(typeof label).toBe("string");
    }
  });

  test("appends retry hint when retryable is true", () => {
    const base = getAgentErrorLabel("timeout", false);
    const retryable = getAgentErrorLabel("timeout", true);
    expect(typeof base).toBe("string");
    expect(typeof retryable).toBe("string");
    expect(retryable).toBe(`${base}，可稍后重试`);
  });

  test("returns null for null/undefined inputs instead of falling back", () => {
    expect(getAgentStatusLabel(null)).toBe(null);
    expect(getAgentStatusLabel(undefined)).toBe(null);
    expect(getAgentErrorLabel(null)).toBe(null);
    expect(getAgentErrorLabel(undefined)).toBe(null);
    expect(getAgentPlanStepStatusLabel(null)).toBe(null);
    expect(getAgentRuntimeIssueLabel(null)).toBe(null);
  });

  test("plan step statuses are all covered", () => {
    const statuses = ["pending", "ready", "running", "completed", "failed"] as const;
    for (const status of statuses) {
      const label = getAgentPlanStepStatusLabel(status);
      expect(typeof label).toBe("string");
    }
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

  test("panel label dictionary entries are non-empty strings", () => {
    const keys: Array<keyof typeof agentPanelLabels> = [
      "planApprovalHeading",
      "planApprovalHint",
      "toolApprovalHeading",
      "toolApprovalHint",
      "planSectionHeading",
      "approvalSubmitting",
      "approvalSubmitFailed",
    ];
    for (const key of keys) {
      const label = agentPanelLabels[key];
      expect(typeof label).toBe("string");
      expect(label.length > 0).toBe(true);
    }
  });

  test("runtime issue labels cover known keys", () => {
    const keys = [
      "live_search_timeout",
      "live_search_failed",
      "live_search_empty",
      "research_failed",
    ];
    for (const key of keys) {
      const label = getAgentRuntimeIssueLabel(key);
      expect(typeof label).toBe("string");
    }
  });
});
