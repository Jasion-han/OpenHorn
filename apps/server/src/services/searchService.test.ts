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

test("buildSearchContext returns offline when no key exists", async () => {
  const result = await buildSearchContext({
    route: "research",
    prompt: "比较最近几家 AI 公司的发布和融资",
  });

  expect(result.status).toBe("offline");
  expect(result.label).toBe("在线研究未配置，任务无法继续");
  expect(result.citations).toEqual([]);
});

test("buildSearchContext returns offline when disabled", async () => {
  const result = await buildSearchContext({
    route: "web_search",
    prompt: "最近 AI 圈有什么新闻",
    envKey: "env-key",
    userSettings: { [TAVILY_ENABLED_SETTING]: "false" },
  });

  expect(result.status).toBe("offline");
  expect(result.label).toBe("实时搜索已关闭，任务无法继续");
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
