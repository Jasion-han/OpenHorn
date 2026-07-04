import { describe, expect, test } from "bun:test";
import { getLanguageMeta } from "./DesktopMarkdownMessage";

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
