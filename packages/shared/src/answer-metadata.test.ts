import { expect, test } from "bun:test";
import { answerModelMetadata } from "./answer-metadata";

test("answer-model annotations and native counters cannot replace separately retrieved sources", () => {
  const metadata = answerModelMetadata({
    citations: [],
    steps: [{ id: "fake", action: "search", status: "completed" }],
    toolUsage: { search: 9, fetch: 0, imageSearch: 0 },
  });
  expect(metadata.citations).toBeUndefined();
  expect(metadata.steps).toBeUndefined();
  expect(metadata.toolUsage).toBeUndefined();
});

test("answer refusals still clear unsafe output while old owned provider state can be persisted", () => {
  const state = {
    provider: "deepseek" as const,
    origin: "https://api.deepseek.com",
    model: "deepseek-flash",
    serverToolCalls: [],
  };
  expect(
    answerModelMetadata({
      providerState: state,
      refused: true,
      citations: [{ url: "https://example.com/" }],
    }),
  ).toEqual({ providerState: state, refused: true });
});
