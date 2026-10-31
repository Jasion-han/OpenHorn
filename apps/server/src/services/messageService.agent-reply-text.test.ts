import { expect, test } from "bun:test";
import { withAgentReplyText } from "./messageService";

/**
 * Agent answers are stored with an empty `content` and the text in agentRun
 * steps. Chat-mode context built from such a conversation must still see them.
 */
test("fills empty Agent replies from agentRun text steps", () => {
  const agentRun = JSON.stringify({
    status: "completed",
    steps: [
      { type: "reasoning", content: "plan" },
      { type: "text", content: "the answer" },
    ],
  });
  const result = withAgentReplyText([
    { role: "user", content: "question", agentRun: null },
    { role: "assistant", content: "", agentRun },
    { role: "assistant", content: "chat reply", agentRun },
  ]);
  expect(result.map((m) => m.content)).toEqual(["question", "the answer", "chat reply"]);
});
