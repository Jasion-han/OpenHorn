import { expect, test } from "bun:test";
import { DEEPSEEK_SEARCH_RUNTIME } from "shared/deepseek-search";
import { TAVILY_SEARCH_RUNTIME_KEY } from "shared/search-settings";
import type { ServerApi } from "./serverApi";
import { resolveRunSettings } from "./sidecarRunSupport";

function api(settings: Record<string, string>): ServerApi {
  return { settings: { get: async () => ({ settings }) } } as unknown as ServerApi;
}

test("send/edit/retry/background settings use the active Tavily key rather than the saved replacement", async () => {
  const run = await resolveRunSettings(
    api({
      "liveSearch.provider": "tavily",
      "liveSearch.tavilyApiKey": "unverified-candidate",
      [TAVILY_SEARCH_RUNTIME_KEY]: "verified-active-key",
    }),
    true,
  );
  expect(run.searchProvider).toBe("tavily");
  expect(run.tavilyApiKey).toBe("verified-active-key");
  expect(run.toolConnection).toBe(undefined);
});

test("an empty modern Tavily runtime never borrows the unverified saved key", async () => {
  const run = await resolveRunSettings(
    api({
      "liveSearch.provider": "auto",
      "liveSearch.tavilyApiKey": "unverified-candidate",
      [TAVILY_SEARCH_RUNTIME_KEY]: "",
    }),
    true,
  );
  expect(run.tavilyApiKey).toBe(undefined);
});

test("a pending DeepSeek replacement is not sent to Sidecar and disabling web search forwards no credentials", async () => {
  const values = {
    "liveSearch.provider": "deepseek",
    [DEEPSEEK_SEARCH_RUNTIME]: JSON.stringify({
      kind: "deepseek",
      baseUrl: "https://api.deepseek.com/v1",
      apiKey: "active-deepseek",
    }),
    "deepseek.searchConnection": JSON.stringify({
      kind: "deepseek",
      source: "manual",
      baseUrl: "https://relay.example.com/v1",
      apiKey: "unverified-replacement",
    }),
  };
  const run = await resolveRunSettings(api(values), true);
  expect(run.toolConnection?.apiKey).toBe("active-deepseek");
  expect((await resolveRunSettings(api(values), false)).toolConnection).toBe(undefined);
});

test("all Agent entry points carry a distinct native retrieval credential without borrowing model or standalone-tool keys", async () => {
  const { NATIVE_SEARCH_RUNTIME } = await import("shared/deepseek-native-search");
  const native = {
    baseUrl: "https://api.deepseek.com/v1",
    model: "deepseek-v4-pro",
    apiKey: "native-retrieval-key",
  };
  const values = {
    "liveSearch.provider": "deepseek-native",
    [NATIVE_SEARCH_RUNTIME]: JSON.stringify(native),
    [DEEPSEEK_SEARCH_RUNTIME]: JSON.stringify({
      kind: "deepseek",
      baseUrl: "https://api.deepseek.com/v1",
      apiKey: "wrong-standalone-key",
    }),
  };
  const run = await resolveRunSettings(api(values), true);
  expect(run.searchProvider).toBe("deepseek-native");
  expect(run.nativeSearchConnection).toEqual(native);
  expect(run.toolConnection).toBe(undefined);
  expect((await resolveRunSettings(api(values), false)).nativeSearchConnection).toBe(undefined);
});

test("OpenRouter run settings load only verified runtime and omit all credentials when web is disabled", async () => {
  const {
    OPENROUTER_SEARCH_RUNTIME,
    OPENROUTER_SEARCH_BASE_URL,
    OPENROUTER_SEARCH_MODEL,
    OPENROUTER_SEARCH_ENGINE,
  } = await import("shared/openrouter-search");
  const connection = {
    baseUrl: OPENROUTER_SEARCH_BASE_URL,
    model: OPENROUTER_SEARCH_MODEL,
    engine: OPENROUTER_SEARCH_ENGINE,
    apiKey: "synthetic-openrouter-key",
  };
  const settings = {
    "liveSearch.provider": "openrouter",
    [OPENROUTER_SEARCH_RUNTIME]: JSON.stringify(connection),
    "openrouter.searchConnection": JSON.stringify({ ...connection, apiKey: "unverified" }),
    "liveSearch.tavilyApiKey": "wrong-tavily",
    "deepseek.toolsApiKey": "wrong-deepseek",
    "jev.apiKey": "wrong-jev",
  };
  const run = await resolveRunSettings(api(settings), true);
  expect(run.searchProvider).toBe("openrouter");
  expect(run.openRouterSearchConnection).toEqual(connection);
  expect(run.tavilyApiKey).toBe(undefined);
  expect(run.deepseekApiKey).toBe(undefined);
  expect(run.nativeSearchConnection).toBe(undefined);
  expect(run.toolConnection).toBe(undefined);
  const missing = await resolveRunSettings(
    api({ ...settings, [OPENROUTER_SEARCH_RUNTIME]: "" }),
    true,
  );
  expect(missing.searchProvider).toBe("openrouter");
  expect(missing.openRouterSearchConnection).toBe(undefined);
  const requested: string[][] = [];
  const disabled = await resolveRunSettings(
    {
      settings: {
        get: async (keys: string[]) => {
          requested.push(keys);
          return { settings };
        },
      },
    } as unknown as ServerApi,
    false,
  );
  expect(requested).toEqual([["chat.systemPrompt"]]);
  expect(disabled.openRouterSearchConnection).toBe(undefined);
  expect(disabled.tavilyApiKey).toBe(undefined);
});

test("unselected OpenRouter runtime is never forwarded", async () => {
  const run = await resolveRunSettings(
    api({
      "liveSearch.provider": "duckduckgo",
      "openrouter.searchRuntime": JSON.stringify({ apiKey: "unused" }),
    }),
    true,
  );
  expect(run.openRouterSearchConnection).toBe(undefined);
});

test("an invalid explicit provider fails closed instead of falling through to auto", async () => {
  const run = await resolveRunSettings(
    api({ "liveSearch.provider": "unsupported", "liveSearch.tavilyApiKey": "must-not-fallback" }),
    true,
  );
  expect(run.searchProvider).toBe("deepseek");
  expect(run.tavilyApiKey).toBe(undefined);
  expect(run.toolConnection).toBe(undefined);
  expect(run.openRouterSearchConnection).toBe(undefined);
});
