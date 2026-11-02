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
  test("ordinary long text and short inline markers have no open fence", () => {
    const paragraph =
      "普通分析文字、emoji 👩🏽‍💻 与组合字符 e\u0301。`代码`、``引用``、~波浪~、~~删除~~。\n\n";
    for (const content of ["", "\n\t ", paragraph, paragraph.repeat(2000)]) {
      expect(endsInsideOpenFence(content)).toBe(false);
    }
  });

  for (const { name, prefix, indent } of containers) {
    test(`tracks open and explicitly closed fences inside ${name}`, () => {
      const open = `${prefix}\`\`\`html-ui\n${indent}<p>partial</p>`;
      expect(endsInsideOpenFence(open)).toBe(true);
      expect(endsInsideOpenFence(`${open}\n${indent}\`\`\``)).toBe(false);
    });

    for (const marker of ["`", "~"]) {
      test(`preserves ${marker} fence character and length rules inside ${name}`, () => {
        const fence = marker.repeat(4);
        const other = marker === "`" ? "~" : "`";
        const open = `${prefix}${fence}html-ui\n${indent}<p>partial</p>`;
        expect(endsInsideOpenFence(open)).toBe(true);
        expect(endsInsideOpenFence(`${open}\n${indent}${marker.repeat(3)}`)).toBe(true);
        expect(endsInsideOpenFence(`${open}\n${indent}${other.repeat(4)}`)).toBe(true);
        expect(endsInsideOpenFence(`${open}\n${indent}${fence} trailing-info`)).toBe(true);
        expect(endsInsideOpenFence(`${open}\n${indent}${fence}`)).toBe(false);
        expect(endsInsideOpenFence(`${open}\n${indent}${marker.repeat(5)}`)).toBe(false);
      });
    }
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
    expect(endsInsideOpenFence("<div>\n~~~html-ui\n<p>HTML raw block</p>")).toBe(false);
    expect(endsInsideOpenFence("    ~~~html-ui\n    indented code")).toBe(false);
    expect(endsInsideOpenFence("ordinary ```inline``` and ~~~inline~~~ text")).toBe(false);
  });

  test("the fence character, length and info string obey CommonMark", () => {
    expect(endsInsideOpenFence("> ````html-ui\n> <p>x</p>\n> ```")).toBe(true);
    expect(endsInsideOpenFence("> ```html-ui\n> <p>x</p>\n> ```js")).toBe(true);
    expect(endsInsideOpenFence("> ~~~html-ui\n> <p>x</p>\n> ~~~~")).toBe(false);
    expect(endsInsideOpenFence("```bad`info\ntext")).toBe(false);
  });
});
