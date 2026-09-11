import { describe, expect, test } from "bun:test";
import { applyAgentEventToRun } from "./chatStore";

describe("applyAgentEventToRun tool_start merge by toolCallId", () => {
  test("early name-only tool_start and later tool_start with input collapse into one step", () => {
    const afterEarly = applyAgentEventToRun(undefined, {
      type: "tool_start",
      toolName: "Read",
      toolCallId: "c1",
    });
    expect(afterEarly.steps).toHaveLength(1);
    const earlyTimestamp = afterEarly.steps[0]?.timestamp;
    expect(earlyTimestamp).toBeDefined();

    const afterFull = applyAgentEventToRun(afterEarly, {
      type: "tool_start",
      toolName: "Read",
      toolCallId: "c1",
      toolInput: { path: "a" },
    });
    expect(afterFull.steps).toHaveLength(1);
    expect(afterFull.steps[0]).toMatchObject({
      type: "tool_start",
      toolName: "Read",
      toolCallId: "c1",
      toolInput: { path: "a" },
    });
    // Elapsed timer keeps counting from the first sighting.
    expect(afterFull.steps[0]?.timestamp).toBe(earlyTimestamp as number);
  });

  test("tool_start with a different toolCallId appends a new step", () => {
    const first = applyAgentEventToRun(undefined, {
      type: "tool_start",
      toolName: "Read",
      toolCallId: "c1",
    });
    const second = applyAgentEventToRun(first, {
      type: "tool_start",
      toolName: "Bash",
      toolCallId: "c2",
      toolInput: { command: "ls" },
    });
    expect(second.steps).toHaveLength(2);
    expect(second.steps[1]).toMatchObject({ toolName: "Bash", toolCallId: "c2" });
  });

  test("tool_start without toolCallId still appends", () => {
    const first = applyAgentEventToRun(undefined, {
      type: "tool_start",
      toolName: "Read",
      toolInput: { path: "a" },
    });
    const second = applyAgentEventToRun(first, {
      type: "tool_start",
      toolName: "Read",
      toolInput: { path: "b" },
    });
    expect(second.steps).toHaveLength(2);
    expect(second.steps[1]?.toolInput).toEqual({ path: "b" });
  });

  test("tool_result carries toolCallId and toolName", () => {
    const run = applyAgentEventToRun(undefined, {
      type: "tool_result",
      toolName: "Read",
      toolCallId: "c1",
      content: "ok",
    });
    expect(run.steps).toHaveLength(1);
    expect(run.steps[0]).toMatchObject({
      type: "tool_result",
      toolName: "Read",
      toolCallId: "c1",
      content: "ok",
    });
  });
});
