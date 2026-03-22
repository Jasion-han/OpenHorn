import { expect, test } from "bun:test";
import { getWebSearchPolicy, routeLiveQuery } from "./liveCapabilities";

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
