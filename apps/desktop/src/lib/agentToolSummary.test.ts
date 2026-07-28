import { describe, expect, test } from "bun:test";
import { extractToolUrls, summarizeToolInput } from "./agentToolSummary";

describe("extractToolUrls", () => {
  test("returns every url of a batched fetch so the panel can give each its own row", () => {
    expect(
      extractToolUrls({
        urls: ["https://a.example/one", "https://b.example/two", "https://c.example/three"],
        query: "ignored",
      }),
    ).toEqual(["https://a.example/one", "https://b.example/two", "https://c.example/three"]);
  });

  test("wraps a single-url tool so both shapes are handled the same way", () => {
    expect(extractToolUrls({ url: " https://a.example " })).toEqual(["https://a.example"]);
  });

  test("drops blanks and non-strings", () => {
    expect(extractToolUrls({ urls: ["https://a.example", "   ", 42, null] })).toEqual([
      "https://a.example",
    ]);
  });

  test("a tool with no url yields an empty list, not a fabricated one", () => {
    expect(extractToolUrls({ query: "tesla stock" })).toEqual([]);
    expect(extractToolUrls(null)).toEqual([]);
  });
});

describe("summarizeToolInput", () => {
  test("lists every url of a multi-url fetch, one per line", () => {
    // The regression this guards: `tavily_extract` sends `urls` AND `query`, so
    // summarising by query rendered a 2-url call and a 3-url call identically.
    const summary = summarizeToolInput({
      urls: ["https://a.example/one", "https://b.example/two", "https://c.example/three"],
      query: "Stable Diffusion 2.1 image generation model",
    });
    expect(summary).toBe("https://a.example/one\nhttps://b.example/two\nhttps://c.example/three");
  });

  test("urls win over query so the pages hit are always visible", () => {
    expect(summarizeToolInput({ url: "https://a.example/one", query: "some query" })).toBe(
      "https://a.example/one",
    );
  });

  test("falls back to the query when a tool only searches", () => {
    expect(summarizeToolInput({ query: "tesla stock price" })).toBe("tesla stock price");
    expect(summarizeToolInput({ q: "  spaced  " })).toBe("spaced");
  });

  test("ignores blank and non-string entries in the url list", () => {
    expect(summarizeToolInput({ urls: ["https://a.example", "  ", 42, null] })).toBe(
      "https://a.example",
    );
  });

  test("an all-blank url list falls through instead of rendering empty", () => {
    expect(summarizeToolInput({ urls: ["   "], query: "fallback" })).toBe("fallback");
  });

  test("still summarises shell commands and file paths", () => {
    expect(summarizeToolInput({ command: "ls -la" })).toBe("ls -la");
    expect(summarizeToolInput({ file_path: "/tmp/x.ts" })).toBe("/tmp/x.ts");
  });

  test("unrecognised shapes serialise, and non-objects yield nothing", () => {
    expect(summarizeToolInput({ foo: 1 })).toBe('{"foo":1}');
    expect(summarizeToolInput(null)).toBe(null);
    expect(summarizeToolInput("string")).toBe(null);
  });
});
