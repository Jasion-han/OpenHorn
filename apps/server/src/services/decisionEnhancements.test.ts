import { expect, test } from "bun:test";
import { createDecisionEnhancements } from "./decisionEnhancements";

test("unavailable decision service preserves suggestions, ranking and full skill eligibility", async () => {
  const service = createDecisionEnhancements(async () => ({ ok: false, reason: "timeout" }));
  expect(await service.filterSuggestions("u", ["new task"], ["old task"])).toBeNull();
  expect(await service.rerank("u", "q", ["a", "b"], (x) => x)).toEqual(["a", "b"]);
  expect(
    (await service.suggestSkill("u", "hello", [{ name: "s", description: "d" }])).preferredNames,
  ).toEqual([]);
});
test("semantic filter retains uncertain candidates and reranking keeps every source", async () => {
  const service = createDecisionEnhancements(async (_user, feature) => ({
    ok: true,
    evaluation: {
      model: "synthetic",
      providerRequestId: "synthetic",
      usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 },
      billedCostUsd: 0,
      cached: false,
      latencyMs: 1,
      answers:
        feature === "suggestions"
          ? { s0: { type: "noul", noul: 0.95 }, s1: { type: "noul", noul: 0.5 } }
          : {
              c0: { type: "score", score: 0, probabilities: { 0: 1 }, confidence: 1 },
              c1: { type: "score", score: 3, probabilities: { 3: 1 }, confidence: 1 },
            },
    },
  }));
  expect(await service.filterSuggestions("u", ["duplicate", "uncertain"], ["old"])).toEqual([
    "uncertain",
  ]);
  expect(await service.rerank("u", "q", ["low", "high"], (x) => x)).toEqual(["high", "low"]);
});

test("skill selection uses meaningful option names and requires a positive applicability judgment", async () => {
  let applicable = 0.98;
  const service = createDecisionEnhancements(async () => ({
    ok: true,
    evaluation: {
      model: "synthetic",
      providerRequestId: "synthetic",
      usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 },
      billedCostUsd: 0,
      cached: false,
      latencyMs: 1,
      answers: {
        applicable: { type: "noul", noul: applicable },
        skill: {
          type: "choice",
          choice: "spreadsheet",
          confidence: 1,
          probabilities: { spreadsheet: 1, documents: 0 },
        },
      },
    },
  }));
  const skills = [
    { name: "documents", description: "Word" },
    { name: "spreadsheet", description: "Excel" },
  ];
  expect((await service.suggestSkill("u", "Excel", skills)).preferredNames).toEqual([
    "spreadsheet",
  ]);
  applicable = 0.4;
  expect((await service.suggestSkill("u", "unclear", skills)).preferredNames).toEqual([]);
});

test("large skill catalogs fit a bounded advisory request without changing the caller's roster", async () => {
  const skills = Array.from({ length: 40 }, (_, index) => ({
    name: `skill-${index}`,
    description: "描述".repeat(350),
  }));
  const service = createDecisionEnhancements(async (_u, _f, request) => {
    expect(Buffer.byteLength(JSON.stringify(request), "utf8") <= 28_000).toBe(true);
    return { ok: false, reason: "disabled" };
  });
  expect((await service.suggestSkill("u", "Choose a useful skill", skills)).preferredNames).toEqual(
    [],
  );
  expect(skills).toHaveLength(40);
});
