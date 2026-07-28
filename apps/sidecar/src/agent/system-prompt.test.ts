import { describe, expect, test } from "bun:test";
import { buildAgentSystemPrompt } from "./system-prompt";

const LINK_RULE = "When the user's message contains a URL, open and read it before answering";
const EVERY_RULE = "Fetch EVERY URL in the message";
const FAILURE_RULE = "Never state or imply you read a page you did not fetch";

describe("buildAgentSystemPrompt link-reading rule", () => {
  test("instructs the agent to open links the user pasted when a fetch tool exists", () => {
    const prompt = buildAgentSystemPrompt({ webFetchAvailable: true });
    expect(prompt.includes(LINK_RULE)).toBe(true);
    expect(prompt.includes(FAILURE_RULE)).toBe(true);
  });

  test("forbids sampling a subset of the links", () => {
    // Observed failure: given three URLs the model fetched two in one batched
    // call, judged the forum thread redundant, and still wrote "based on the
    // three links". Covering "read the links" alone did not rule that out.
    const prompt = buildAgentSystemPrompt({ webFetchAvailable: true });
    expect(prompt.includes(EVERY_RULE)).toBe(true);
    expect(prompt.includes("You may not sample")).toBe(true);
    expect(prompt.includes("call it again until all of them are covered")).toBe(true);
  });

  test("omits the rules when the runtime registered no fetch tool", () => {
    // Otherwise the model is told to fetch with nothing to fetch with, and the
    // likeliest outcome is that it answers as though it had read the page.
    const prompt = buildAgentSystemPrompt({ webFetchAvailable: false });
    expect(prompt.includes(LINK_RULE)).toBe(false);
    expect(prompt.includes(EVERY_RULE)).toBe(false);
    expect(prompt.includes(FAILURE_RULE)).toBe(false);
  });

  test("omits the rule by default, so a runtime must opt in", () => {
    expect(buildAgentSystemPrompt().includes(LINK_RULE)).toBe(false);
  });

  test("keeps the rest of the prompt intact in both cases", () => {
    const withFetch = buildAgentSystemPrompt({ webFetchAvailable: true });
    const withoutFetch = buildAgentSystemPrompt({ webFetchAvailable: false });
    for (const prompt of [withFetch, withoutFetch]) {
      expect(prompt.includes("# Web search & freshness")).toBe(true);
      expect(prompt.includes("Search results are ranked by relevance")).toBe(true);
      expect(prompt.includes("# Safety")).toBe(true);
    }
    expect(withFetch.length > withoutFetch.length).toBe(true);
  });
});
