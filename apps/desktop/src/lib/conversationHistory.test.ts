import { describe, expect, test } from "bun:test";
import { buildConversationHistory } from "./conversationHistory";

describe("buildConversationHistory", () => {
  test("keeps user / assistant turns in order", () => {
    const history = buildConversationHistory([
      { role: "user", content: "remember 42" },
      { role: "assistant", content: "ok, 42" },
      { role: "user", content: "what number?" },
    ]);
    expect(history).toEqual([
      { role: "user", content: "remember 42" },
      { role: "assistant", content: "ok, 42" },
      { role: "user", content: "what number?" },
    ]);
  });

  test("drops empty messages and non-chat roles", () => {
    const history = buildConversationHistory([
      { role: "system", content: "sys" },
      { role: "user", content: "   " },
      { role: "assistant", content: "" },
      { role: "assistant", content: " plain " },
    ]);
    expect(history).toEqual([{ role: "assistant", content: "plain" }]);
  });
});
