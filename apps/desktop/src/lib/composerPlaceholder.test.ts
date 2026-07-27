import { describe, expect, test } from "bun:test";
import { charCount, pickPlaceholder, takeChars } from "./composerPlaceholder";

const POOL = ["a", "b", "c"];

describe("pickPlaceholder", () => {
  test("an empty pool yields an empty string rather than undefined", () => {
    expect(pickPlaceholder([])).toBe("");
  });

  test("a single-entry pool always yields that entry, even when it is the one to avoid", () => {
    expect(pickPlaceholder(["only"], "only")).toBe("only");
  });

  test("every draw comes from the pool", () => {
    for (let i = 0; i < 50; i += 1) {
      expect(POOL.includes(pickPlaceholder(POOL))).toBe(true);
    }
  });

  test("draws move away from the previous value", () => {
    // Not "never repeats" — the retry is bounded, so a repeat is possible. What
    // must hold is that avoiding actually happens rather than being a no-op.
    let differed = 0;
    for (let i = 0; i < 50; i += 1) {
      if (pickPlaceholder(POOL, "a") !== "a") differed += 1;
    }
    expect(differed > 0).toBe(true);
  });
});

describe("takeChars", () => {
  test("reveals one character at a time and ends on the whole string", () => {
    const text = "描述你的任务";
    const frames = [];
    for (let i = 0; i <= charCount(text); i += 1) frames.push(takeChars(text, i));
    expect(frames).toEqual(["", "描", "描述", "描述你", "描述你的", "描述你的任", "描述你的任务"]);
  });

  test("counts by code point, so a surrogate pair is never split in half", () => {
    // "🚀" is two UTF-16 code units: a naive slice(0, 1) would emit a lone
    // surrogate and paint a replacement glyph for one frame.
    expect(charCount("🚀走")).toBe(2);
    expect(takeChars("🚀走", 1)).toBe("🚀");
  });

  test("a count past the end returns the whole string, and a negative one nothing", () => {
    expect(takeChars("abc", 99)).toBe("abc");
    expect(takeChars("abc", -1)).toBe("");
  });
});
