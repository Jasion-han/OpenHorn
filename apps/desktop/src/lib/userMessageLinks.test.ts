import { expect, test } from "bun:test";
import { findUserMessageLinks } from "./userMessageLinks";

test("links next to Chinese text exclude sentence punctuation and preserve all source offsets", () => {
  const text = "看看https://example.com/a，另一个：https://example.org/b。\n原文不变";
  const links = findUserMessageLinks(text);
  expect(links.map((link) => text.slice(link.start, link.end))).toEqual([
    "https://example.com/a",
    "https://example.org/b",
  ]);
  let restored = "",
    at = 0;
  for (const link of links) {
    restored += text.slice(at, link.start) + text.slice(link.start, link.end);
    at = link.end;
  }
  expect(restored + text.slice(at)).toBe(text);
});

test("balanced URL parentheses, queries, hashes and adjacent links retain the actual destination", () => {
  const text =
    "(https://example.com/a_(b)). https://example.org/?x=1&next=https://other.org#section,https://third.org/end";
  expect(findUserMessageLinks(text).map((link) => link.url)).toEqual([
    "https://example.com/a_(b)",
    "https://example.org/?x=1&next=https://other.org#section",
    "https://third.org/end",
  ]);
});

test("Unicode URLs are preserved and the pasted forum ID does not absorb glued Chinese prose", () => {
  const text =
    "https://例子.中国/资料 https://example.org/123资料 https://discuss.huggingface.co/t/stable-diffusion-2-1/171866目前没看懂他在做什么";
  expect(findUserMessageLinks(text).map((link) => text.slice(link.start, link.end))).toEqual([
    "https://例子.中国/资料",
    "https://example.org/123资料",
    "https://discuss.huggingface.co/t/stable-diffusion-2-1/171866",
  ]);
});

test("only absolute HTTP(S) URLs become links", () => {
  expect(
    findUserMessageLinks(
      "javascript:alert(1) data:text/html,test file:///tmp/a ftp://example.org user@example.org www.example.org",
    ),
  ).toHaveLength(0);
  expect(findUserMessageLinks("not a link: https://")).toHaveLength(0);
  expect(findUserMessageLinks("HTTPS://example.org/a")[0]?.url).toBe("https://example.org/a");
});
