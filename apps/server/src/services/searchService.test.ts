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
