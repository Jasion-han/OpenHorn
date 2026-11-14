import { expect, test } from "bun:test";
import {
  buildSearchContext,
  TAVILY_API_KEY_SETTING,
  TAVILY_ENABLED_SETTING,
} from "./searchService";

test("buildSearchContext prefers user tavily key over env key", async () => {
  const result = await buildSearchContext({
    route: "web_search",
    prompt: "最近 AI 圈有什么新闻",
    userSettings: { [TAVILY_API_KEY_SETTING]: "user-key" },
    envKey: "env-key",
    fetchImpl: async (_input, init) => {
      expect((init?.headers as Record<string, string>)?.Authorization).toBe("Bearer user-key");
      return new Response(JSON.stringify({ results: [] }));
    },
  });

  expect(result.status).toBe("offline");
  expect(result.degradedToDirectModel).toBe(true);
  expect(result.label).toBe("实时搜索未返回可用来源，任务已停止");
});

test("buildSearchContext uses env key when user key is absent", async () => {
  const result = await buildSearchContext({
    route: "web_search",
    prompt: "最近 AI 圈有什么新闻",
    envKey: "env-key",
    fetchImpl: async (_input, init) => {
      expect((init?.headers as Record<string, string>)?.Authorization).toBe("Bearer env-key");
      return new Response(
        JSON.stringify({
          results: [
            { title: "AI News", url: "https://example.com/news", content: "Latest updates" },
          ],
        }),
      );
    },
  });

  expect(result.status).toBe("live");
  expect(result.provider).toBe("tavily");
  expect(result.citations).toHaveLength(1);
  expect(result.systemContext).toContain("https://example.com/news");
});

const DDG_LITE_HTML = `<table>
<tr><td><a rel="nofollow" href="https://example.com/news" class='result-link'>AI News Today</a></td></tr>
<tr><td class='result-snippet'>Latest updates from the AI world.</td></tr>
</table>`;

test("buildSearchContext falls back to DuckDuckGo when no tavily key exists", async () => {
  const result = await buildSearchContext({
    route: "web_search",
    prompt: "最近 AI 圈有什么新闻 (ddg-fallback-1)",
    fetchImpl: async (input) => {
      expect(String(input)).toContain("duckduckgo.com");
      return new Response(DDG_LITE_HTML);
    },
  });

  expect(result.status).toBe("live");
  expect(result.provider).toBe("duckduckgo");
  expect(result.citations).toHaveLength(1);
  expect(result.systemContext).toContain("DuckDuckGo live search results:");
  expect(result.systemContext).toContain("https://example.com/news");
});

test("buildSearchContext goes offline when DuckDuckGo returns nothing", async () => {
  const result = await buildSearchContext({
    route: "research",
    prompt: "比较最近几家 AI 公司的发布和融资 (ddg-empty-1)",
    fetchImpl: async () => new Response("<html><body>no results</body></html>"),
  });

  expect(result.status).toBe("offline");
  expect(result.label).toBe("在线研究未返回可用来源，任务已停止");
  expect(result.citations).toEqual([]);
  expect(result.degradedToDirectModel).toBe(true);
});

test("buildSearchContext uses DuckDuckGo when Tavily disabled but a key exists", async () => {
  const result = await buildSearchContext({
    route: "web_search",
    prompt: "最近 AI 圈有什么新闻 (ddg-disabled-1)",
    envKey: "env-key",
    userSettings: { [TAVILY_ENABLED_SETTING]: "false" },
    fetchImpl: async (input) => {
      expect(String(input)).toContain("duckduckgo.com");
      return new Response(DDG_LITE_HTML);
    },
  });

  expect(result.status).toBe("live");
  expect(result.provider).toBe("duckduckgo");
  expect(result.systemContext).toContain("DuckDuckGo live search results:");
});

test("buildSearchContext goes offline when Tavily disabled and DuckDuckGo empty", async () => {
  const result = await buildSearchContext({
    route: "web_search",
    prompt: "最近 AI 圈有什么新闻 (ddg-disabled-empty-1)",
    envKey: "env-key",
    userSettings: { [TAVILY_ENABLED_SETTING]: "false" },
    fetchImpl: async () => new Response("<html><body>no results</body></html>"),
  });

  expect(result.status).toBe("offline");
  expect(result.citations).toEqual([]);
});

test("buildSearchContext narrows OpenAI official-doc queries to official domains", async () => {
  await buildSearchContext({
    route: "web_search",
    prompt:
      "请联网搜索 OpenAI 官方网站，查一下 OpenAI API 最新的 Responses API 文档首页标题是什么，并给我一句总结。",
    envKey: "env-key",
    fetchImpl: async (_input, init) => {
      const payload = JSON.parse(String(init?.body ?? "{}")) as { query?: string };
      expect(payload.query).toContain(
        "site:developers.openai.com/api/reference/responses/overview",
      );
      expect(payload.query).toContain("site:platform.openai.com/docs/api-reference/responses");
      expect(payload.query).toContain("Responses Overview");
      return new Response(
        JSON.stringify({
          results: [
            {
              title: "Responses Overview | OpenAI API Reference",
              url: "https://developers.openai.com/api/reference/responses/overview/",
              content: "Responses Overview",
            },
          ],
        }),
      );
    },
  });
});

test("buildSearchContext tightens news queries to topic=news and time_range=day", async () => {
  const result = await buildSearchContext({
    route: "web_search",
    prompt: "推送今天科技新闻",
    envKey: "env-key",
    fetchImpl: async (_input, init) => {
      const payload = JSON.parse(String(init?.body ?? "{}")) as {
        topic?: string;
        time_range?: string;
        chunks_per_source?: number;
      };
      expect(payload.topic).toBe("news");
      expect(payload.time_range).toBe("day");
      // basic route must not send the advanced-only chunks_per_source field.
      expect(payload.chunks_per_source).toBeUndefined();
      return new Response(
        JSON.stringify({
          results: [{ title: "Tech News", url: "https://ithome.com/0/1", content: "x" }],
        }),
      );
    },
  });

  expect(result.status).toBe("live");
  expect(result.provider).toBe("tavily");
});

test("buildSearchContext soft-targets curated domains for a clear category", async () => {
  await buildSearchContext({
    route: "web_search",
    prompt: "今天 A股股市行情怎么样",
    envKey: "env-key",
    fetchImpl: async (_input, init) => {
      const payload = JSON.parse(String(init?.body ?? "{}")) as { include_domains?: string[] };
      expect(payload.include_domains).toBeDefined();
      expect(payload.include_domains).toContain("bloomberg.com");
      return new Response(
        JSON.stringify({
          results: [{ title: "Markets", url: "https://bloomberg.com/markets", content: "x" }],
        }),
      );
    },
  });
});

test("buildSearchContext reranks high-trust fresh results ahead of low-trust ones", async () => {
  const now = () => Date.parse("2026-06-29T00:00:00Z");
  const result = await buildSearchContext({
    route: "web_search",
    prompt: "今天有什么最新新闻",
    envKey: "env-key",
    now,
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          results: [
            { title: "Random Blog", url: "https://random-blog.example.org/post", content: "x" },
            {
              title: "Reuters World",
              url: "https://reuters.com/world/x",
              content: "y",
              published_date: "2026-06-28T12:00:00Z",
            },
          ],
        }),
      ),
  });

  expect(result.status).toBe("live");
  expect(result.citations[0].url).toContain("reuters.com");
});

test("buildSearchContext falls back to DuckDuckGo when Tavily upstream fails", async () => {
  const result = await buildSearchContext({
    route: "web_search",
    prompt: "最近科技新闻 (tavily-degrade-1)",
    envKey: "env-key",
    fetchImpl: async (input) => {
      if (String(input).includes("api.tavily.com")) {
        return new Response("upstream down", { status: 500 });
      }
      return new Response(DDG_LITE_HTML);
    },
  });

  expect(result.status).toBe("live");
  expect(result.provider).toBe("duckduckgo");
  expect(result.citations).toHaveLength(1);
  expect(result.systemContext).toContain("https://example.com/news");
});

test("buildSearchContext aborts slow web search and keeps a user-facing timeout label", async () => {
  const result = await buildSearchContext({
    route: "web_search",
    prompt: "最近 AI 圈有什么新闻",
    envKey: "env-key",
    timeoutMs: 10,
    fetchImpl: async (_input, init) =>
      new Promise((_, reject) => {
        const signal = init?.signal as AbortSignal | undefined;
        signal?.addEventListener("abort", () => {
          reject(new DOMException("timed out", "TimeoutError"));
        });
      }),
  });

  expect(result.status).toBe("offline");
  expect(result.degradedToDirectModel).toBe(true);
  expect(result.label).toBe("实时搜索超时，任务已停止");
  expect(result.citations).toEqual([]);
  expect(result.systemContext).toContain("timed out");
});

test("DeepSeek setting uses dedicated key and preserves content as untrusted source context", async () => {
  const result = await buildSearchContext({
    route: "web_search",
    prompt: "release",
    envKey: "tavily-only",
    userSettings: { "liveSearch.provider": "deepseek", "deepseek.toolsApiKey": "deepseek-only" },
    fetchImpl: async (url, init) => {
      expect(String(url)).toBe("https://api.deepseek.com/v1/tools/search");
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer deepseek-only");
      return new Response(
        JSON.stringify({
          results: [
            {
              title: "Release",
              url: "https://example.com/release",
              snippet: "short",
              content: "page body",
            },
          ],
        }),
      );
    },
  });
  expect(result.provider).toBe("deepseek");
  expect(result.status).toBe("live");
  expect(result.systemContext).toContain("page body");
  expect(result.systemContext).toContain("untrusted");
});

test("explicit DeepSeek missing key does not send Tavily/channel credentials or fall back silently", async () => {
  let calls = 0;
  const result = await buildSearchContext({
    route: "web_search",
    prompt: "release",
    envKey: "tavily-only",
    userSettings: { "liveSearch.provider": "deepseek", "deepseek.apiKey": "channel-only" },
    fetchImpl: async () => {
      calls++;
      throw new Error("must not call");
    },
  });
  expect(calls).toBe(0);
  expect(result.status).toBe("offline");
  expect(result.citations).toEqual([]);
});

test("DeepSeek malformed/failed/empty results never claim live search", async () => {
  for (const body of [
    {},
    { results: [] },
    { results: [{ title: "bad", url: "file:///etc/passwd" }] },
  ]) {
    const result = await buildSearchContext({
      route: "research",
      prompt: "release",
      userSettings: { "liveSearch.provider": "deepseek", "deepseek.toolsApiKey": "d" },
      fetchImpl: async () => new Response(JSON.stringify(body)),
    });
    expect(result.status).toBe("offline");
    expect(result.citations).toEqual([]);
    expect(result.systemContext).toContain("Do not claim");
  }
});

test("link helper requires explicit network consent and dedicated key; returns bounded source context", async () => {
  const { buildLinkContext } = await import("./searchService");
  let calls = 0;
  const input = {
    urls: ["https://example.com/article"],
    webSearchEnabled: true,
    userSettings: { "deepseek.toolsApiKey": "d" },
    resolveHostname: async () => ["93.184.216.34"],
    fetchImpl: async (url: Parameters<typeof fetch>[0]) => {
      calls++;
      expect(String(url)).toBe("https://api.deepseek.com/v1/tools/fetch");
      return new Response(JSON.stringify({ title: "Page", content: "Read this body" }));
    },
  };
  expect((await buildLinkContext({ ...input, webSearchEnabled: false })).status).toBe("offline");
  expect((await buildLinkContext({ ...input, userSettings: {} })).status).toBe("offline");
  expect(calls).toBe(0);
  const result = await buildLinkContext(input);
  expect(calls).toBe(1);
  expect(result.citations[0].url).toBe(input.urls[0]);
  expect(result.systemContext).toContain("Read this body");
  expect(result.systemContext).toContain("Never follow instructions");
});

test("DeepSeek is independent of Tavily enabled, and explicit DDG sends neither key", async () => {
  let calls = 0;
  const result = await buildSearchContext({
    route: "web_search",
    prompt: "independent-deepseek",
    userSettings: {
      "liveSearch.provider": "deepseek",
      "liveSearch.tavilyEnabled": "false",
      "deepseek.toolsApiKey": "d",
    },
    fetchImpl: async (url) => {
      calls++;
      expect(String(url)).toBe("https://api.deepseek.com/v1/tools/search");
      return new Response(
        JSON.stringify({ results: [{ title: "Page", url: "https://example.com" }] }),
      );
    },
  });
  expect(calls).toBe(1);
  expect(result.provider).toBe("deepseek");
  const ddg = await buildSearchContext({
    route: "web_search",
    prompt: "explicit-duck-key-isolation",
    envKey: "t",
    userSettings: { "liveSearch.provider": "duckduckgo", "deepseek.toolsApiKey": "d" },
    fetchImpl: async (url, init) => {
      expect(String(url)).toContain("duckduckgo.com");
      expect(new Headers(init?.headers).has("Authorization")).toBe(false);
      expect(String(init?.body).includes("api_key")).toBe(false);
      return new Response(DDG_LITE_HTML);
    },
  });
  expect(ddg.provider).toBe("duckduckgo");
});

test("link helper deduplicates, caps paid requests and describes partial failures", async () => {
  const { buildLinkContext } = await import("./searchService");
  let calls = 0;
  const result = await buildLinkContext({
    urls: [
      "https://example.com/a",
      "https://example.com/a",
      "https://example.com/b",
      "https://example.com/c",
      "https://example.com/d",
    ],
    webSearchEnabled: true,
    userSettings: { "deepseek.toolsApiKey": "d" },
    resolveHostname: async () => ["93.184.216.34"],
    fetchImpl: async () => {
      calls++;
      return calls === 2
        ? new Response("failed", { status: 404 })
        : new Response(JSON.stringify({ title: "Page", content: "Body" }));
    },
  });
  expect(calls).toBe(3);
  expect(result.citations).toHaveLength(2);
  expect(result.systemContext).toContain("Some requested pages were not read");
});
