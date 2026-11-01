import { describe, expect, test } from "bun:test";
import type { ApiAgentRunStep } from "../types/chat";
import { keyedAgentSteps } from "./agentStepKeys";

describe("Agent process step identity", () => {
  test("keeps identities across content/status updates and unrelated insertions", () => {
    const original: ApiAgentRunStep[] = [
      { type: "tool_detail", toolCallId: "call-1", status: "in_progress" },
      { type: "reasoning", timestamp: 100, content: "thinking" },
    ];
    const updated: ApiAgentRunStep[] = [
      { type: "plan", timestamp: 99, planEntries: [] },
      { ...original[0], status: "completed", timestamp: 200, toolName: "updated title" },
      { ...original[1], content: "thinking more" },
    ];
    expect(
      keyedAgentSteps(updated)
        .slice(1)
        .map((entry) => entry.key),
    ).toEqual(keyedAgentSteps(original).map((entry) => entry.key));
  });

  test("distinguishes tool start/result and duplicate legacy steps without changing earlier keys on append", () => {
    const steps: ApiAgentRunStep[] = [
      { type: "tool_start", toolCallId: "call-1" },
      { type: "tool_result", toolCallId: "call-1" },
      { type: "error", content: "legacy first" },
      { type: "error", content: "legacy second" },
    ];
    const keys = keyedAgentSteps(steps).map((entry) => entry.key);
    expect(new Set(keys).size).toBe(steps.length);
    expect(
      keyedAgentSteps([...steps, { type: "error" }])
        .slice(0, steps.length)
        .map((entry) => entry.key),
    ).toEqual(keys);
  });
});
