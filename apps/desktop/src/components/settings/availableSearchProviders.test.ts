import { expect, test } from "bun:test";
import { availableSearchProviders } from "./availableSearchProviders";

test("available menu never invents providers when a backend has no verification catalog", () => {
  expect(availableSearchProviders(undefined, "tavily")).toEqual([]);
  expect(availableSearchProviders(["openrouter", "openrouter"], "openrouter")).toEqual([
    "openrouter",
  ]);
});
test("DeepSeek protocols appear once and preserve the currently enabled connection", () => {
  expect(
    availableSearchProviders(["deepseek", "deepseek-native", "openrouter"], "deepseek"),
  ).toEqual(["deepseek", "openrouter"]);
  expect(availableSearchProviders(["deepseek", "deepseek-native"], "tavily")).toEqual([
    "deepseek-native",
  ]);
});

test("legacy Tavily remains visible beside verified OpenRouter without inventing verification", () => {
  expect(availableSearchProviders(["openrouter"], "openrouter", ["tavily", "openrouter"])).toEqual([
    "tavily",
    "openrouter",
  ]);
  expect(
    availableSearchProviders(["deepseek"], "openrouter", ["deepseek-native", "deepseek"]),
  ).toEqual(["deepseek"]);
});
