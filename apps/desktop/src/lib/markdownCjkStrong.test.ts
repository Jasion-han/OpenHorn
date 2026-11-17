import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { remarkCjkStrong } from "./markdownCjkStrong";

const render = (source: string) =>
  renderToStaticMarkup(
    createElement(ReactMarkdown, { remarkPlugins: [remarkGfm, remarkCjkStrong] }, source),
  );

test("real PDF response renders padded CJK emphasis without literal stars", () => {
  expect(render("右柱约为左柱的 **1.8 倍 **（大致比例 1:1.8）。")).toBe(
    "<p>右柱约为左柱的 <strong>1.8 倍</strong>（大致比例 1:1.8）。</p>",
  );
});

test("the persisted PDF answer keeps both closing delimiters and adjacent CJK punctuation", () => {
  expect(render("右柱约为左柱的 **1.8 倍**（大致比例 **1:1.8**）。")).toBe(
    "<p>右柱约为左柱的 <strong>1.8 倍</strong>（大致比例 <strong>1:1.8</strong>）。</p>",
  );
});

test("real research heading closes emphasis before adjacent CJK prose", () => {
  expect(render("**定位：basic 适合日常查询。**官方文档说明如下。 ")).toBe(
    "<p><strong>定位：basic 适合日常查询。</strong>官方文档说明如下。</p>",
  );
});

test("CJK emphasis does not insert spaces into prose or modify code samples", () => {
  expect(render("这里**加粗。**继续")).toBe("<p>这里<strong>加粗。</strong>继续</p>");
  const source = "`这里**原样。**保留`\n\n```text\n这里**原样。**保留\n```";
  expect(render(source)).toBe(
    '<p><code>这里**原样。**保留</code></p>\n<pre><code class="language-text">这里**原样。**保留\n</code></pre>',
  );
});

test("escaped stars, ordinary valid Markdown and link destinations retain their meaning", () => {
  expect(render("\\*\\*中文\\*\\*")).toBe("<p>**中文**</p>");
  expect(render("**正常中文** and **English**")).toBe(
    "<p><strong>正常中文</strong> and <strong>English</strong></p>",
  );
  const link = "[来源](https://example.com/**中文**)";
  expect(render(link)).toBe(renderToStaticMarkup(createElement(ReactMarkdown, {}, link)));
  const autolink = "<https://example.com/**中文**>";
  expect(render(autolink)).toBe(renderToStaticMarkup(createElement(ReactMarkdown, {}, autolink)));
});
