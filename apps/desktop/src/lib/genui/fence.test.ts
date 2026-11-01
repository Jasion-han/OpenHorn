import { describe, expect, test } from "bun:test";
import { endsInsideOpenFence } from "./fence";

const containers = [
  { name: "top level", prefix: "", indent: "" },
  { name: "blockquote", prefix: "> ", indent: "> " },
  { name: "nested quote", prefix: "> > ", indent: "> > " },
  { name: "list", prefix: "- ", indent: "  " },
  { name: "numbered list", prefix: "12. ", indent: "    " },
  { name: "list in quote", prefix: "> - ", indent: ">   " },
];

describe("Markdown streaming uses the renderer's CommonMark and GFM grammar", () => {
  for (const { name, prefix, indent } of containers) {
    test(`tracks open and explicitly closed fences inside ${name}`, () => {
      const open = `${prefix}\`\`\`html-ui\n${indent}<p>partial</p>`;
      expect(endsInsideOpenFence(open)).toBe(true);
      expect(endsInsideOpenFence(`${open}\n${indent}\`\`\``)).toBe(false);
    });
  }

  test("tracks a GFM footnote container", () => {
    const open = "[^a]:\n    ```html-ui\n    <p>partial</p>";
    expect(endsInsideOpenFence(open)).toBe(true);
    expect(endsInsideOpenFence(`${open}\n    \`\`\``)).toBe(false);
  });

  test("does not execute an earlier block while the final nested block is still open", () => {
    const content = "```html-ui\n<p>one</p>\n```\n\n> ```html-ui\n> <p>two</p>";
    expect(endsInsideOpenFence(content)).toBe(true);
  });

  test("a quote ending before the current tail ends its unclosed child fence", () => {
    expect(endsInsideOpenFence("> ```html-ui\n> <p>closed by container</p>\n\noutside")).toBe(
      false,
    );
  });

  test("code-looking lines in HTML and indented code blocks are not fences", () => {
    expect(endsInsideOpenFence("<div>\n```html-ui\n<p>HTML raw block</p>")).toBe(false);
    expect(endsInsideOpenFence("    ```html-ui\n    indented code")).toBe(false);
  });

  test("the fence character, length and info string obey CommonMark", () => {
    expect(endsInsideOpenFence("> ````html-ui\n> <p>x</p>\n> ```")).toBe(true);
    expect(endsInsideOpenFence("> ```html-ui\n> <p>x</p>\n> ```js")).toBe(true);
    expect(endsInsideOpenFence("> ~~~html-ui\n> <p>x</p>\n> ~~~~")).toBe(false);
    expect(endsInsideOpenFence("```bad`info\ntext")).toBe(false);
  });
});
