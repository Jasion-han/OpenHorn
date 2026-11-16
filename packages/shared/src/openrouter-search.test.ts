import { expect, test } from "bun:test";
import {
  OPENROUTER_SEARCH_BASE_URL,
  OPENROUTER_SEARCH_CONFIG,
  OPENROUTER_SEARCH_ENGINE,
  OPENROUTER_SEARCH_MODEL,
  OPENROUTER_SEARCH_RUNTIME,
  parseOpenRouterSearchConfig,
  readOpenRouterSearchRuntime,
} from "./openrouter-search";

test("OpenRouter config freezes the tested endpoint, model and search engine", () => {
  const parsed = parseOpenRouterSearchConfig(JSON.stringify({ apiKey: "fixture-search" }));
  expect(parsed).toEqual({
    apiKey: "fixture-search",
    baseUrl: OPENROUTER_SEARCH_BASE_URL,
    model: OPENROUTER_SEARCH_MODEL,
    engine: OPENROUTER_SEARCH_ENGINE,
  });
});

test("OpenRouter config rejects alternate targets, models, ambiguous search engines and invalid credentials", () => {
  for (const override of [
    { baseUrl: "https://example.com/api/v1" },
    { model: "typesafe/jev-1.14" },
    { engine: "native" },
    { apiKey: "" },
    { apiKey: "bad key" },
    { apiKey: "__cli_oauth__:fixture" },
  ]) {
    let failed = false;
    try {
      parseOpenRouterSearchConfig(JSON.stringify({ apiKey: "fixture-search", ...override }));
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
  }
});

test("OpenRouter runtime only accepts the explicitly active complete frozen contract", () => {
  const config = JSON.stringify(
    parseOpenRouterSearchConfig(JSON.stringify({ apiKey: "fixture-search" })),
  );
  expect(
    readOpenRouterSearchRuntime({
      [OPENROUTER_SEARCH_CONFIG]: config,
      "jev.apiKey": "fixture-jev",
    }),
  ).toBe(undefined);
  expect(
    readOpenRouterSearchRuntime({
      [OPENROUTER_SEARCH_RUNTIME]: JSON.stringify({ apiKey: "fixture-search" }),
    }),
  ).toBe(undefined);
  expect(readOpenRouterSearchRuntime({ [OPENROUTER_SEARCH_RUNTIME]: config })?.model).toBe(
    OPENROUTER_SEARCH_MODEL,
  );
});

test("Flash is the default while explicit Pro retains its complete runtime contract", () => {
  expect(OPENROUTER_SEARCH_MODEL).toBe("deepseek/deepseek-v4-flash");
  const legacy = {
    apiKey: "legacy-search-key",
    baseUrl: OPENROUTER_SEARCH_BASE_URL,
    model: "deepseek/deepseek-v4-pro",
    engine: OPENROUTER_SEARCH_ENGINE,
  };
  expect(parseOpenRouterSearchConfig(JSON.stringify(legacy))).toEqual(legacy);
  expect(
    readOpenRouterSearchRuntime({ [OPENROUTER_SEARCH_RUNTIME]: JSON.stringify(legacy) }),
  ).toEqual(legacy);
});
