import { describe, expect, test } from "bun:test";
import { agentPanelLabels, getAgentActionLabel } from "./agent";

describe("agent i18n dictionary", () => {
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
});
