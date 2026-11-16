import { expect, test } from "bun:test";
import {
  DEEPSEEK_SEARCH_RUNTIME,
  parseDeepSeekSearchConfig,
  readDeepSeekSearchRuntime,
} from "./deepseek-search";
import { searchToolService } from "./search/toolProvider";
import { LEGACY_TOOL_KEY, TOOL_RUNTIME_SETTING } from "./tool-connection";

test("DeepSeek search never selects a different source based on address or model", async () => {
  const connection = {
    kind: "deepseek" as const,
    baseUrl: "https://openrouter.ai/api/v1",
    apiKey: "route-only",
  };
  const urls: string[] = [];
  await expect(
    searchToolService("release", {
      connection,
      resolveHostname: async () => ["93.184.216.34"],
      fetchImpl: async (url) => {
        urls.push(String(url));
        return new Response("unsupported", { status: 404 });
      },
    }),
  ).rejects.toThrow("HTTP 404");
  expect(urls).toEqual(["https://openrouter.ai/api/v1/tools/search"]);
  expect(() =>
    parseDeepSeekSearchConfig(
      JSON.stringify({ ...connection, source: "manual", kind: "openrouter", model: "test/model" }),
    ),
  ).toThrow("deepseek_search_source_required");
});

test("unavailable modern search config never falls back to another credential", () => {
  expect(
    readDeepSeekSearchRuntime({ [DEEPSEEK_SEARCH_RUNTIME]: "", [LEGACY_TOOL_KEY]: "old-official" }),
  ).toBeUndefined();
  expect(
    readDeepSeekSearchRuntime({
      [TOOL_RUNTIME_SETTING]: JSON.stringify({
        kind: "openrouter",
        baseUrl: "https://openrouter.ai/api/v1",
        apiKey: "router-only",
        model: "test/model",
      }),
      [LEGACY_TOOL_KEY]: "old-official",
    }),
  ).toBeUndefined();
  expect(readDeepSeekSearchRuntime({ [LEGACY_TOOL_KEY]: "old-official" })?.kind).toBe("deepseek");
});
