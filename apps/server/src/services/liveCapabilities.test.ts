import { expect, test } from "bun:test";
import { buildLiveContext, getWebSearchPolicy, routeLiveQuery } from "./liveCapabilities";

test("data-only review batches cannot invoke weather, web, classifier or workspace enrichment", async () => {
  let calls = 0;
  for (const prompt of ["上海今天天气", "帮我联网查询最新新闻", "查看当前工作目录"]) {
    const result = await buildLiveContext({
      prompt,
      dataOnly: true,
      forceWebSearch: true,
      classifier: async () => {
        calls++;
        return "web_search";
      },
      fetchImpl: async () => {
        calls++;
        throw new Error("External requests forbidden");
      },
    });
    expect(result).toEqual({ status: "offline", route: "direct_model", source: { type: "none" } });
  }
  expect(calls).toBe(0);
});

test("routeLiveQuery classifies local time questions", () => {
  expect(routeLiveQuery("今天周几")).toEqual({
    type: "local",
    needsCitation: false,
  });
});

test("routeLiveQuery classifies weather questions", () => {
  expect(routeLiveQuery("今天天气怎么样").type).toBe("structured_live");
});

test("routeLiveQuery classifies recent-news questions", () => {
  expect(routeLiveQuery("最近 AI 圈有什么新闻").type).toBe("web_search");
});

test("routeLiveQuery classifies research-heavy requests separately", () => {
  expect(routeLiveQuery("帮我比较最近几家 AI 公司的发布和融资").type).toBe("research");
});

test("routeLiveQuery leaves non-live prompts as direct model", () => {
  expect(routeLiveQuery("把这段话翻译成英文").type).toBe("direct_model");
});

test("getWebSearchPolicy blocks identity questions from web search", () => {
  expect(getWebSearchPolicy("你是什么模型？")).toBe("never");
});

test("getWebSearchPolicy forces web search for explicit lookup prompts", () => {
  expect(getWebSearchPolicy("帮我查一下 OpenAI 最新动态")).toBe("always_web_search");
});

test("getWebSearchPolicy still forces web search when lookup prompts also request a summary", () => {
  expect(
    getWebSearchPolicy(
      "请联网搜索 OpenAI 官方网站，查一下 OpenAI API 最新的 Responses API 文档首页标题是什么，并给我一句总结。",
    ),
  ).toBe("always_web_search");
});

test("getWebSearchPolicy forces research for recent comparison prompts", () => {
  expect(getWebSearchPolicy("帮我调研最近几家 AI 公司的发布和融资")).toBe("always_research");
});

test("getWebSearchPolicy treats current interview-practice comparisons as research", () => {
  expect(getWebSearchPolicy("现在的 AI 面试一般是怎么面的？和传统前端面试有什么差异？")).toBe(
    "always_research",
  );
});

test("an explicitly disabled conversation cannot initiate any paid search or weather lookup", async () => {
  let calls = 0;
  for (const prompt of ["最近 AI 圈有什么新闻", "调研最近的AI技术", "上海天气怎么样"]) {
    const result = await buildLiveContext({
      prompt,
      forceWebSearch: false,
      userSettings: {
        "liveSearch.provider": "deepseek-native",
        "deepseek.nativeSearchRuntime": JSON.stringify({
          baseUrl: "https://api.deepseek.com/v1",
          model: "deepseek-v4-pro",
          apiKey: "synthetic-native-key",
        }),
      },
      classifier: async () => {
        calls++;
        return "web_search";
      },
      fetchImpl: async () => {
        calls++;
        throw new Error("must not fetch");
      },
    });
    expect(result.status).toBe("offline");
    expect(result.source.type).toBe("none");
  }
  expect(calls).toBe(0);
});

test("Stop during semantic classification prevents a later paid retrieval even when the classifier ignores cancellation", async () => {
  const controller = new AbortController();
  let release!: (route: "web_search") => void, entered!: () => void;
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let calls = 0;
  const pending = buildLiveContext({
    prompt: "给我一些建议",
    forceWebSearch: true,
    signal: controller.signal,
    classifier: async () => {
      entered();
      return new Promise<"web_search">((resolve) => {
        release = resolve;
      });
    },
    fetchImpl: async () => {
      calls++;
      throw new Error("must not fetch");
    },
  });
  await waiting;
  controller.abort();
  release("web_search");
  await expect(pending).rejects.toThrow();
  expect(calls).toBe(0);
});
