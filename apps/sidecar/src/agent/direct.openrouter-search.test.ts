import { expect, test } from "bun:test";
import {
  OPENROUTER_SEARCH_BASE_URL,
  OPENROUTER_SEARCH_ENGINE,
  OPENROUTER_SEARCH_MODEL,
} from "shared/openrouter-search";
import { executeTool, runWebSearch } from "./direct";

const connection = {
  apiKey: "synthetic-openrouter-key",
  baseUrl: OPENROUTER_SEARCH_BASE_URL,
  model: OPENROUTER_SEARCH_MODEL,
  engine: OPENROUTER_SEARCH_ENGINE,
} as const;

test("Agent Search uses independent OpenRouter retrieval and keeps provider private fields out", async () => {
  let calls = 0;
  const result = await runWebSearch("docs", {
    searchProvider: "openrouter",
    openRouterSearchConnection: connection,
    tavilyApiKey: "wrong-tavily",
    deepseekApiKey: "wrong-deepseek",
    fetchImpl: async (url, init) => {
      calls++;
      expect(String(url)).toBe("https://openrouter.ai/api/v1/chat/completions");
      expect(new Headers(init?.headers).get("Authorization")).toBe(
        "Bearer synthetic-openrouter-key",
      );
      return Response.json({
        choices: [
          {
            finish_reason: "stop",
            message: {
              role: "assistant",
              content: "Synthetic summary",
              reasoning: "private",
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
    },
  });
  expect(calls).toBe(1);
  expect(result.includes("model_generated_summary")).toBe(true);
  expect(result.includes("private")).toBe(false);
  expect(result.includes(connection.apiKey)).toBe(false);
});

test("missing/failed OpenRouter never borrows another provider and disabled web performs no request", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return Response.json({ error: { message: connection.apiKey } });
  };
  await runWebSearch("docs", {
    searchProvider: "openrouter",
    tavilyApiKey: "wrong",
    deepseekApiKey: "wrong",
    fetchImpl,
  });
  expect(calls).toBe(0);
  const failed = await runWebSearch("docs", {
    searchProvider: "openrouter",
    openRouterSearchConnection: connection,
    tavilyApiKey: "wrong",
    fetchImpl,
  });
  expect(calls).toBe(1);
  expect(failed.includes("Do not claim")).toBe(true);
  expect(failed.includes(connection.apiKey)).toBe(false);
  const disabled = await executeTool("web_search", { query: "docs" }, "/tmp", {
    webSearchEnabled: false,
    searchProvider: "openrouter",
    openRouterSearchConnection: connection,
    fetchImpl,
  });
  expect(disabled).toBe("Error: web access is disabled");
  expect(calls).toBe(1);
});

test("explicit Fetch uses safe page reading even with stale standalone credentials, never OpenRouter summary or Key", async () => {
  let calls = 0;
  const options = {
    webSearchEnabled: true,
    searchProvider: "openrouter" as const,
    openRouterSearchConnection: connection,
    deepseekApiKey: "stale-standalone",
    resolveHostname: async () => ["93.184.216.34"],
    fetchImpl: async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      calls++;
      expect(String(url)).toBe("https://example.com/docs");
      expect(new Headers(init?.headers).get("Authorization")).toBe(null);
      return new Response("Synthetic original page text", {
        headers: { "Content-Type": "text/plain" },
      });
    },
  };
  const result = await executeTool(
    "web_fetch",
    { url: "https://example.com/docs" },
    "/tmp",
    options,
  );
  expect(result.includes("Synthetic original page text")).toBe(true);
  expect(result.includes("model_generated_summary")).toBe(false);
  await executeTool("web_fetch", { url: "http://127.0.0.1/private" }, "/tmp", options);
  expect(calls).toBe(1);
});
