import { expect, test } from "bun:test";
import { buildLiveContext } from "./liveCapabilities";

test("buildLiveContext resolves weekday locally", async () => {
  const result = await buildLiveContext({
    prompt: "今天周几",
    now: new Date("2026-03-16T09:00:00+08:00"),
    timezone: "Asia/Shanghai",
  });

  expect(result.status).toBe("live");
  expect(result.source.type).toBe("local");
  expect(result.userLabel).toContain("本地时间");
  expect(result.systemContext).toContain("Monday");
});

test("buildLiveContext resolves weather via structured live data", async () => {
  const result = await buildLiveContext({
    prompt: "上海今天天气怎么样",
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          current: {
            temperature_2m: 19.3,
            apparent_temperature: 18.8,
            weather_code: 1,
            wind_speed_10m: 12.4,
          },
          daily: {
            temperature_2m_max: [23.5],
            temperature_2m_min: [14.2],
            precipitation_probability_max: [35],
            weather_code: [1],
          },
        }),
      ) as Response,
  });

  expect(result.status).toBe("live");
  expect(result.route).toBe("structured_live");
  expect(result.source.type).toBe("weather");
  expect(result.userLabel).toContain("Shanghai");
  expect(result.systemContext).toContain("19.3");
  expect(result.systemContext).toContain("Partly cloudy");
});

test("buildLiveContext does not guess weather location from timezone or defaults", async () => {
  const result = await buildLiveContext({
    prompt: "今天天气怎么样",
    timezone: "Asia/Shanghai",
  });

  expect(result.status).toBe("offline");
  expect(result.route).toBe("structured_live");
  expect(result.userLabel).toContain("缺少位置");
  expect(result.systemContext).toContain("Do not infer the user location");
});

test("buildLiveContext marks web-search routes as degraded when no provider exists", async () => {
  const result = await buildLiveContext({
    prompt: "最近 AI 圈有什么新闻",
    tavilyEnvKey: null,
  });

  expect(result.status).toBe("offline");
  expect(result.route).toBe("web_search");
  expect(result.userLabel).toContain("实时搜索未配置");
  expect(result.systemContext).toContain("Live search is not configured");
});

test("buildLiveContext uses tavily for web search when a key is available", async () => {
  const result = await buildLiveContext({
    prompt: "最近 AI 圈有什么新闻",
    tavilyEnvKey: "env-key",
    fetchImpl: async (_input, init) => {
      expect((init?.headers as Record<string, string>)?.Authorization).toBe("Bearer env-key");
      return new Response(
        JSON.stringify({
          results: [
            {
              title: "AI Roundup",
              url: "https://example.com/ai-roundup",
              content: "New AI launches this week.",
              published_date: "2026-03-15",
            },
          ],
        }),
      );
    },
  });

  expect(result.status).toBe("live");
  expect(result.route).toBe("web_search");
  expect(result.userLabel).toContain("实时搜索");
  expect(result.source.type).toBe("web_search");
  expect(result.citations).toHaveLength(1);
  expect(result.systemContext).toContain("AI Roundup");
});

test("buildLiveContext can use semantic classifier when keyword routing is direct_model", async () => {
  const result = await buildLiveContext({
    prompt: "请帮我查一下最近 OpenAI 的动态",
    tavilyEnvKey: "env-key",
    classifier: async () => "web_search",
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          results: [
            {
              title: "OpenAI Update",
              url: "https://example.com/openai-update",
              content: "Product announcements this week.",
            },
          ],
        }),
      ),
  });

  expect(result.status).toBe("live");
  expect(result.route).toBe("web_search");
  expect(result.citations).toHaveLength(1);
  expect(result.systemContext).toContain("OpenAI Update");
});

test("buildLiveContext does not force web search for identity questions even when enabled", async () => {
  let classifierCalled = false;

  const result = await buildLiveContext({
    prompt: "你是什么模型？",
    forceWebSearch: true,
    classifier: async () => {
      classifierCalled = true;
      return "web_search";
    },
  });

  expect(classifierCalled).toBe(false);
  expect(result.route).toBe("direct_model");
  expect(result.status).toBe("offline");
  expect(result.userLabel).toContain("未联网");
});

test("buildLiveContext does not force web search for translation prompts even when enabled", async () => {
  let classifierCalled = false;

  const result = await buildLiveContext({
    prompt: "把这句话翻译成英文",
    forceWebSearch: true,
    classifier: async () => {
      classifierCalled = true;
      return "web_search";
    },
  });

  expect(classifierCalled).toBe(false);
  expect(result.route).toBe("direct_model");
  expect(result.status).toBe("offline");
});

test("buildLiveContext prefers web search for named tool capability lookups when allowed", async () => {
  let classifierCalled = false;

  const result = await buildLiveContext({
    prompt: "OpenClaw 有什么能力？",
    forceWebSearch: true,
    tavilyEnvKey: null,
    classifier: async () => {
      classifierCalled = true;
      return "direct_model";
    },
  });

  expect(classifierCalled).toBe(false);
  expect(result.route).toBe("web_search");
  expect(result.status).toBe("offline");
  expect(result.userLabel).toContain("实时搜索未配置");
});

test("buildLiveContext prefers research for named tool comparison lookups when allowed", async () => {
  let classifierCalled = false;

  const result = await buildLiveContext({
    prompt: "OpenClaw 相较于 AI 编程工具有什么优势？",
    forceWebSearch: true,
    tavilyEnvKey: null,
    classifier: async () => {
      classifierCalled = true;
      return "direct_model";
    },
  });

  expect(classifierCalled).toBe(false);
  expect(result.route).toBe("research");
  expect(result.status).toBe("offline");
  expect(result.userLabel).toContain("实时搜索未配置");
});

test("buildLiveContext routes current interview-practice comparisons to research", async () => {
  let classifierCalled = false;

  const result = await buildLiveContext({
    prompt: "现在的 AI 面试一般是怎么面的？和传统技术方向面试有什么差异？",
    forceWebSearch: true,
    tavilyEnvKey: null,
    classifier: async () => {
      classifierCalled = true;
      return "direct_model";
    },
  });

  expect(classifierCalled).toBe(false);
  expect(result.route).toBe("research");
  expect(result.status).toBe("offline");
  expect(result.userLabel).toContain("实时搜索未配置");
});
