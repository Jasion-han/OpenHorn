import { expect, test } from "bun:test";
import { relevanceDecisionRequest, reviewDecisionRequest } from "./decision-questions";
import { JEV_RESOLVED_MODEL, parseDecisionResponse, probabilityVerdict } from "./decisions";

test("decision payloads keep ratings/secrets out and use the actual Score array protocol", () => {
  const review = reviewDecisionRequest([{ text: "Synthetic" }]);
  expect(Object.keys(review.questions)).toHaveLength(8);
  expect(JSON.stringify(review).includes("rating")).toBe(false);
  const relevance = relevanceDecisionRequest("query", [{ text: "passage" }]);
  expect(Array.isArray(relevance.questions.c0.criteria)).toBe(true);
  expect(probabilityVerdict(0.3)).toBe("no");
  expect(probabilityVerdict(0.5)).toBe("uncertain");
  expect(probabilityVerdict(0.7)).toBe("yes");
});
test("typed decision validation rejects missing options, wrong versions and invented choices", () => {
  const request = relevanceDecisionRequest("query", [{ text: "passage" }]);
  const good = {
    model: JEV_RESOLVED_MODEL,
    id: "synthetic",
    answers: {
      c0: { type: "score", score: 3, confidence: 1, probabilities: { 0: 0, 1: 0, 2: 0, 3: 1 } },
    },
    usage: { input_tokens: 10, output_tokens: 5, cost: 0.00000042 },
  };
  expect(parseDecisionResponse(good, request).model).toBe(JEV_RESOLVED_MODEL);
  for (const value of [
    { ...good, model: "another-model" },
    { ...good, answers: {} },
    { ...good, usage: { input_tokens: 10, output_tokens: 5 } },
  ])
    expect(() => parseDecisionResponse(value, request)).toThrow();
});
