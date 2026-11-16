import { expect, test } from "bun:test";
import { readSearchExecutionSource } from "./search-settings";

test("search execution provenance only carries known provider identifiers", () => {
  expect(readSearchExecutionSource({ provider: "tavily", apiKey: "fixture-secret" })).toEqual({
    provider: "tavily",
  });
  expect(readSearchExecutionSource({ provider: "duckduckgo", fallbackFrom: "tavily" })).toEqual({
    provider: "duckduckgo",
    fallbackFrom: "tavily",
  });
  for (const value of [
    null,
    [],
    "tavily",
    { provider: "unknown" },
    { provider: "openrouter", fallbackFrom: "tavily" },
    { provider: "duckduckgo", fallbackFrom: "openrouter" },
  ]) {
    expect(readSearchExecutionSource(value)).toBe(undefined);
  }
});
