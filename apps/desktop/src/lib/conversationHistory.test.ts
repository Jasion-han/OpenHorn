import { describe, expect, test } from "bun:test";
import { buildConversationHistory } from "./conversationHistory";

describe("buildConversationHistory", () => {
  test("keeps Agent replies stored only in agentRun text steps", () => {
    const history = buildConversationHistory([
      { role: "user", content: "remember 42" },
      {
        role: "assistant",
        content: "",
        agentRun: {
          status: "completed",
          steps: [
            { type: "reasoning", content: "plan" },
            { type: "text", content: "ok, 42" },
          ],
        },
      },
      { role: "user", content: "what number?" },
    ]);
    expect(history).toEqual([
      { role: "user", content: "remember 42" },
      { role: "assistant", content: "ok, 42" },
      { role: "user", content: "what number?" },
    ]);
  });

  test("reads agentRun stored as a JSON string (server rows)", () => {
    const history = buildConversationHistory([
      {
        role: "assistant",
        content: "",
        agentRun: JSON.stringify({ steps: [{ type: "text", content: "answer" }] }),
      },
    ]);
    expect(history).toEqual([{ role: "assistant", content: "answer" }]);
  });

  test("drops empty messages and non-chat roles", () => {
    const history = buildConversationHistory([
      { role: "system", content: "sys" },
      { role: "user", content: "   " },
      { role: "assistant", content: "", agentRun: { steps: [] } },
      { role: "assistant", content: " plain " },
    ]);
    expect(history).toEqual([{ role: "assistant", content: "plain" }]);
  });
});
