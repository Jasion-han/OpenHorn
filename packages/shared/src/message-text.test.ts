import { describe, expect, test } from "bun:test";
import { messageText } from "./message-text";

describe("messageText", () => {
  test("prefers non-empty content", () => {
    expect(
      messageText({
        content: " hello ",
        agentRun: { steps: [{ type: "text", content: "ignored" }] },
      }),
    ).toBe("hello");
  });

  test("falls back to agentRun text steps (object)", () => {
    expect(
      messageText({
        content: "",
        agentRun: {
          status: "completed",
          steps: [
            { type: "reasoning", content: "thinking aloud" },
            { type: "text", content: "first\n" },
            { type: "tool_start", toolName: "Bash" },
            { type: "thinking", content: "hidden" },
            { type: "text", content: "  " },
            { type: "text", content: "second" },
          ],
        },
      }),
    ).toBe("first\n\nsecond");
  });

  test("parses agentRun stored as a JSON string", () => {
    const agentRun = JSON.stringify({
      status: "completed",
      steps: [{ type: "text", content: "蓝鲸42" }],
    });
    expect(messageText({ content: "", agentRun })).toBe("蓝鲸42");
  });

  test("returns empty string for missing / malformed agentRun", () => {
    expect(messageText({ content: "" })).toBe("");
    expect(messageText({ content: null, agentRun: null })).toBe("");
    expect(messageText({ content: "", agentRun: "{not json" })).toBe("");
    expect(messageText({ content: "", agentRun: { steps: "nope" } })).toBe("");
  });
});
