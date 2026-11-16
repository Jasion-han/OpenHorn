import { expect, test } from "bun:test";
import {
  OPENROUTER_SEARCH_BASE_URL,
  OPENROUTER_SEARCH_ENGINE,
  OPENROUTER_SEARCH_MODEL,
  OPENROUTER_SEARCH_RUNTIME,
} from "shared/openrouter-search";
import { buildLinkContext, buildSearchContext, SEARCH_SETTINGS_KEYS } from "./searchService";

const connection = {
  apiKey: "synthetic-openrouter-key",
  baseUrl: OPENROUTER_SEARCH_BASE_URL,
  model: OPENROUTER_SEARCH_MODEL,
  engine: OPENROUTER_SEARCH_ENGINE,
};
const settings = {
  "liveSearch.provider": "openrouter",
  [OPENROUTER_SEARCH_RUNTIME]: JSON.stringify(connection),
  "liveSearch.tavilyApiKey": "wrong-tavily",
  "jev.apiKey": "wrong-jev",
};
const payload = () => ({
  choices: [
    {
      finish_reason: "stop",
      message: {
        role: "assistant",
        content: "Synthetic summary",
        reasoning: "private-reasoning",
        annotations: [
          {
            type: "url_citation",
            url_citation: { url: "https://example.com/docs", title: "Docs" },
          },
        ],
      },
    },
  ],
});

test("server search/research consumes only selected verified OpenRouter runtime and labels the secondary summary", async () => {
  expect(SEARCH_SETTINGS_KEYS.includes(OPENROUTER_SEARCH_RUNTIME)).toBe(true);
  for (const route of ["web_search", "research"] as const) {
    let calls = 0;
    const result = await buildSearchContext({
      prompt: "Synthetic docs",
      route,
      userSettings: settings,
      fetchImpl: async (url, init) => {
        calls++;
        expect(String(url)).toBe("https://openrouter.ai/api/v1/chat/completions");
        expect(new Headers(init?.headers).get("Authorization")).toBe(
          "Bearer synthetic-openrouter-key",
        );
        return Response.json(payload());
      },
    });
    expect(result.status).toBe("live");
    expect(result.provider).toBe("openrouter");
    expect(calls).toBe(1);
    expect(result.citations).toHaveLength(1);
    expect(result.systemContext?.includes("not original page text")).toBe(true);
    expect(result.systemContext?.includes(connection.apiKey)).toBe(false);
    expect(result.systemContext?.includes("private-reasoning")).toBe(false);
  }
});

test("server fails closed for unverified/failed OpenRouter, with no paid or keyless fallback", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return Response.json({ error: { message: connection.apiKey } }, { status: 502 });
  };
  const missing = await buildSearchContext({
    prompt: "docs",
    route: "web_search",
    userSettings: {
      ...settings,
      [OPENROUTER_SEARCH_RUNTIME]: "",
      "openrouter.searchConnection": JSON.stringify(connection),
    },
    fetchImpl,
  });
  expect(missing.status).toBe("offline");
  expect(calls).toBe(0);
  const failed = await buildSearchContext({
    prompt: "docs",
    route: "web_search",
    userSettings: settings,
    fetchImpl,
  });
  expect(failed.status).toBe("offline");
  expect(failed.citations).toHaveLength(0);
  expect(calls).toBe(1);
  expect(failed.systemContext?.includes(connection.apiKey)).toBe(false);
});

test("server cancellation propagates and explicit links do not turn a search summary into page text", async () => {
  const controller = new AbortController();
  let calls = 0,
    aborted = false;
  try {
    await buildSearchContext({
      prompt: "docs",
      route: "web_search",
      userSettings: settings,
      signal: controller.signal,
      fetchImpl: async () => {
        calls++;
        controller.abort();
        return new Promise<Response>(() => {});
      },
    });
  } catch {
    aborted = true;
  }
  expect(aborted).toBe(true);
  expect(calls).toBe(1);
  const result = await buildLinkContext({
    urls: ["https://example.com/docs"],
    webSearchEnabled: true,
    userSettings: settings,
    fetchImpl: async () => {
      calls++;
      return Response.json(payload());
    },
  });
  expect(result.status).toBe("offline");
  expect(calls).toBe(1);
});
