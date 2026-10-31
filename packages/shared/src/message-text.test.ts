import { describe, expect, test } from "bun:test";
import {
  agentRunReplyText,
  assistantFinishReason,
  assistantMessageContent,
  hasAgentReplyTextSteps,
} from "./message-text";

describe("agentRunReplyText", () => {
  test("joins text steps and skips reasoning / thinking / tool steps", () => {
    expect(
      agentRunReplyText({
        status: "completed",
        steps: [
          { type: "reasoning", content: "thinking aloud" },
          { type: "text", content: "first\n" },
          { type: "tool_start", toolName: "Bash" },
          { type: "thinking", content: "hidden" },
          { type: "text", content: "  " },
          { type: "text", content: "second" },
        ],
      }),
    ).toBe("first\n\nsecond");
  });

  test("parses agentRun stored as a JSON string", () => {
    const agentRun = JSON.stringify({
      status: "completed",
      steps: [{ type: "text", content: "蓝鲸42" }],
    });
    expect(agentRunReplyText(agentRun)).toBe("蓝鲸42");
  });

  test("returns empty string for missing / malformed agentRun", () => {
    expect(agentRunReplyText(undefined)).toBe("");
    expect(agentRunReplyText(null)).toBe("");
    expect(agentRunReplyText("{not json")).toBe("");
    expect(agentRunReplyText({ steps: "nope" })).toBe("");
  });
});

describe("assistantMessageContent", () => {
  test("text steps override whatever content the caller passed", () => {
    const run = { steps: [{ type: "text", content: "answer" }] };
    expect(assistantMessageContent("", run)).toBe("answer");
    expect(assistantMessageContent("stale", run)).toBe("answer");
    expect(assistantMessageContent("stale", JSON.stringify(run))).toBe("answer");
  });

  test("whitespace-only text steps still own the content", () => {
    expect(assistantMessageContent("stale", { steps: [{ type: "text", content: " " }] })).toBe("");
  });

  test("a run without text steps stores empty content, never the given text", () => {
    expect(assistantMessageContent("task summary", { status: "completed", steps: [] })).toBe("");
    expect(
      assistantMessageContent("Error: boom", { status: "failed", error: "boom", steps: [] }),
    ).toBe("");
    expect(hasAgentReplyTextSteps({ steps: [{ type: "reasoning", content: "x" }] })).toBe(false);
  });

  test("messages without an agent run keep their content", () => {
    expect(assistantMessageContent("chat reply", null)).toBe("chat reply");
    expect(assistantMessageContent("chat reply", undefined)).toBe("chat reply");
    expect(assistantMessageContent("chat reply", "null")).toBe("chat reply");
    expect(assistantMessageContent("chat reply", "{not json")).toBe("chat reply");
  });
});

describe("assistantFinishReason", () => {
  test("keeps an explicit stop", () => {
    expect(assistantFinishReason("stopped", undefined)).toBe("stopped");
  });

  test("a cancelled agent run is a stopped reply, parsed or stored as JSON", () => {
    expect(assistantFinishReason(undefined, { status: "cancelled", steps: [] })).toBe("stopped");
    expect(assistantFinishReason(null, JSON.stringify({ status: "cancelled", steps: [] }))).toBe(
      "stopped",
    );
  });

  test("anything else is null — a finished reply clears an earlier stop", () => {
    expect(assistantFinishReason(undefined, undefined)).toBe(null);
    expect(assistantFinishReason("bogus", { status: "completed", steps: [] })).toBe(null);
    expect(assistantFinishReason(null, "not json")).toBe(null);
  });
});
