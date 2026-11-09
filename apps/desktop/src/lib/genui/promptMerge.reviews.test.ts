import { expect, test } from "bun:test";
import { REVIEW_JSON_SYSTEM_TAG } from "shared/reviews";
import { withGenUiMessages, withGenUiPrompt } from "./promptMerge";

test("review JSON sessions keep their output contract when generative UI is enabled", () => {
  const prompt = `${REVIEW_JSON_SYSTEM_TAG}\nReturn JSON only.`;
  const messages = [
    { role: "system", content: prompt },
    { role: "user", content: "Classify" },
  ];
  expect(withGenUiMessages(messages, "Prefer interactive widgets")).toBe(messages);
  expect(withGenUiPrompt(prompt, "Prefer interactive widgets")).toBe(prompt);
  expect(withGenUiMessages([{ role: "user", content: "ordinary" }], "Use UI")[0].content).toBe(
    "Use UI",
  );
});
