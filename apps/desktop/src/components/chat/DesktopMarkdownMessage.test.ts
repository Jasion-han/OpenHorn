import { describe, expect, test } from "bun:test";
import {
  getLanguageMeta,
  shouldHighlightEagerly,
  stripLeadingThematicBreak,
} from "./DesktopMarkdownMessage";

describe("getLanguageMeta", () => {
  test("maps known aliases to a canonical prism syntax", () => {
    expect(getLanguageMeta("ts")).toMatchObject({ label: "TypeScript", syntax: "typescript" });
    expect(getLanguageMeta("py")).toMatchObject({ label: "Python", syntax: "python" });
    expect(getLanguageMeta("sh")).toMatchObject({ label: "Shell", syntax: "bash" });
  });

  test("is case and whitespace insensitive", () => {
    expect(getLanguageMeta("  TSX ")).toMatchObject({ label: "React TSX", syntax: "tsx" });
  });

  test("falls back to a plain-text label when language is missing", () => {
    expect(getLanguageMeta(undefined)).toMatchObject({ label: "Plain text", syntax: "text" });
    expect(getLanguageMeta("")).toMatchObject({ label: "Plain text", syntax: "text" });
  });

  test("echoes unknown languages with a neutral accent", () => {
    const meta = getLanguageMeta("rust");
    expect(meta.label).toBe("rust");
    expect(meta.syntax).toBe("rust");
    expect(meta.accent).toBe("#64748b");
  });
});

describe("shouldHighlightEagerly", () => {
  test("highlights a small block synchronously", () => {
    expect(shouldHighlightEagerly("export const x = 1;", 1)).toBe(true);
  });

  test("defers a block with too many lines", () => {
    expect(shouldHighlightEagerly("a\n".repeat(20), 20)).toBe(false);
  });

  test("defers a block whose single line is too long", () => {
    expect(shouldHighlightEagerly("x".repeat(2001), 1)).toBe(false);
  });

  test("highlights at the line-count boundary", () => {
    expect(shouldHighlightEagerly("a", 12)).toBe(true);
  });

  test("defers just past the line-count boundary", () => {
    expect(shouldHighlightEagerly("a", 13)).toBe(false);
  });

  test("highlights at the char-count boundary", () => {
    expect(shouldHighlightEagerly("x".repeat(2000), 1)).toBe(true);
  });
});

describe("stripLeadingThematicBreak", () => {
  test("removes a rule the answer opens with", () => {
    expect(stripLeadingThematicBreak("---\n\n# 今日要闻\n\n正文")).toBe("# 今日要闻\n\n正文");
  });

  test("accepts the other thematic-break spellings", () => {
    expect(stripLeadingThematicBreak("***\n正文")).toBe("正文");
    expect(stripLeadingThematicBreak("___\n正文")).toBe("正文");
    expect(stripLeadingThematicBreak("-----\n正文")).toBe("正文");
  });

  test("keeps rules that separate sections", () => {
    const content = "# 标题\n\n第一段\n\n---\n\n第二段";
    expect(stripLeadingThematicBreak(content)).toBe(content);
  });

  test("leaves content that merely starts with a dash alone", () => {
    expect(stripLeadingThematicBreak("- 第一项\n- 第二项")).toBe("- 第一项\n- 第二项");
    expect(stripLeadingThematicBreak("-- 不是分隔线")).toBe("-- 不是分隔线");
  });

  test("leaves ordinary text untouched", () => {
    expect(stripLeadingThematicBreak("你好")).toBe("你好");
    expect(stripLeadingThematicBreak("")).toBe("");
  });
});
