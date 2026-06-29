import { expect, test } from "bun:test";
import {
  CURATED_SOURCES,
  classifyCategory,
  domainsForCategory,
  trustScore,
} from "./curatedSources";

test("trustScore matches exact curated hosts", () => {
  expect(trustScore("https://reuters.com/world/x")).toBe(1.0);
  expect(trustScore("https://www.theguardian.com/uk")).toBe(0.8);
  expect(trustScore("https://news.ycombinator.com/item?id=1")).toBe(0.5);
});

test("trustScore merges www/m subdomains and TLD variants to the main domain", () => {
  expect(trustScore("https://m.bbc.com/news")).toBe(1.0);
  expect(trustScore("https://bbc.co.uk/news/uk")).toBe(1.0);
  expect(trustScore("https://www.caixin.com/article")).toBe(1.0);
});

test("trustScore returns the 0.3 baseline for unknown or malformed urls", () => {
  expect(trustScore("https://some-random-unlisted-site.xyz/post")).toBe(0.3);
  expect(trustScore("not a real url")).toBe(0.3);
});

test("domainsForCategory caps at the requested max", () => {
  // news has more than 12 entries; the default cap keeps include_domains focused.
  expect(domainsForCategory("news").length).toBe(12);
  expect(domainsForCategory("finance", { max: 3 })).toHaveLength(3);
  expect(domainsForCategory("finance", { max: 3 })).toEqual(["bloomberg.com", "wsj.com", "ft.com"]);
});

test("domainsForCategory can filter by language", () => {
  const zhNews = domainsForCategory("news", { lang: "zh", max: 50 });
  expect(zhNews).toContain("caixin.com");
  expect(zhNews.every((domain) => CURATED_SOURCES.news.some((s) => s.domain === domain))).toBe(
    true,
  );
  const enNews = domainsForCategory("news", { lang: "en", max: 50 });
  expect(enNews).toContain("reuters.com");
});

test("classifyCategory routes clear queries to their category", () => {
  expect(classifyCategory("今天 A股股市行情怎么样")).toBe("finance");
  expect(classifyCategory("最新 arxiv 论文研究进展")).toBe("science");
  expect(classifyCategory("github 上的开源项目代码")).toBe("dev");
  expect(classifyCategory("新款手机芯片评测")).toBe("tech");
  expect(classifyCategory("今天发生了什么新闻")).toBe("news");
});

test("classifyCategory returns null for ambiguous queries", () => {
  expect(classifyCategory("你好吗")).toBe(null);
  expect(classifyCategory("帮我写一首诗")).toBe(null);
});
