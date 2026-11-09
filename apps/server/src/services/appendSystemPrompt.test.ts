import { expect, test } from "bun:test";
import { REVIEW_JSON_SYSTEM_TAG } from "shared/reviews";
import {
  APPEND_SYSTEM_PROMPT_MAX_LENGTH,
  parseAppendSystemPrompt,
  withAppendedSystemPrompt,
} from "./appendSystemPrompt";

test("parseAppendSystemPrompt ignores absent, non-string and blank values", () => {
  expect(parseAppendSystemPrompt(undefined)).toEqual({});
  expect(parseAppendSystemPrompt(null)).toEqual({});
  expect(parseAppendSystemPrompt(42)).toEqual({});
  expect(parseAppendSystemPrompt({ text: "x" })).toEqual({});
  expect(parseAppendSystemPrompt("   \n ")).toEqual({});
});

test("parseAppendSystemPrompt trims and accepts values up to the cap", () => {
  expect(parseAppendSystemPrompt("  extra  ")).toEqual({ value: "extra" });
  const atCap = "a".repeat(APPEND_SYSTEM_PROMPT_MAX_LENGTH);
  expect(parseAppendSystemPrompt(atCap)).toEqual({ value: atCap });
});

test("parseAppendSystemPrompt rejects values over the cap", () => {
  expect(parseAppendSystemPrompt("a".repeat(APPEND_SYSTEM_PROMPT_MAX_LENGTH + 1))).toEqual({
    error: "appendSystemPrompt is too long",
  });
});

test("withAppendedSystemPrompt appends after the effective prompt", () => {
  expect(withAppendedSystemPrompt("Base", "Extra")).toBe("Base\n\nExtra");
  expect(withAppendedSystemPrompt(null, "Extra")).toBe("Extra");
});

test("withAppendedSystemPrompt leaves the effective prompt unchanged without an addendum", () => {
  expect(withAppendedSystemPrompt("Base", undefined)).toBe("Base");
  expect(withAppendedSystemPrompt("Base", "")).toBe("Base");
  expect(withAppendedSystemPrompt(null, undefined)).toBe(null);
});

test("review classification preserves JSON mode during regenerate and edit", () => {
  const prompt = `${REVIEW_JSON_SYSTEM_TAG}\nReturn only JSON.`;
  expect(withAppendedSystemPrompt(prompt, "Render interactive UI")).toBe(prompt);
});
