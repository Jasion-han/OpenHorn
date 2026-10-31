import { describe, expect, test } from "bun:test";
import { agentReplyContent, agentRunReplyText, hasAgentReplyTextSteps } from "./message-text";

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

describe("agentReplyContent", () => {
  test("text steps override whatever content the caller passed", () => {
    const run = { steps: [{ type: "text", content: "answer" }] };
    expect(agentReplyContent("", run)).toBe("answer");
    expect(agentReplyContent("stale", run)).toBe("answer");
  });

  test("whitespace-only text steps still own the content", () => {
    expect(agentReplyContent("stale", { steps: [{ type: "text", content: " " }] })).toBe("");
  });

  test("runs without text steps keep the given content", () => {
    expect(agentReplyContent("task summary", { status: "completed", steps: [] })).toBe(
      "task summary",
    );
    expect(agentReplyContent("chat reply", null)).toBe("chat reply");
    expect(hasAgentReplyTextSteps({ steps: [{ type: "reasoning", content: "x" }] })).toBe(false);
  });
});
