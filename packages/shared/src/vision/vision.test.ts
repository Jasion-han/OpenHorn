import { describe, expect, test } from "bun:test";
import { modelSupportsVision } from "./index";

describe("modelSupportsVision", () => {
  test("recognizes known vision-capable models (case-insensitive)", () => {
    const visionIds = [
      "gpt-4o",
      "gpt-4o-mini",
      "GPT-4O",
      "gpt-4.1",
      "gpt-4-turbo",
      "gpt-4-vision-preview",
      "chatgpt-4o-latest",
      "o1",
      "o3-mini",
      "o4-mini",
      "claude-3-5-sonnet-20241022",
      "claude-sonnet-4-20250514",
      "claude-opus-4-20250514",
      "claude-haiku-4",
      "gemini-1.5-pro",
      "gemini-2.0-flash",
      "qwen-vl-max",
      "qwen2.5-vl-72b-instruct",
      "glm-4v",
      "glm-4.1v-thinking",
      "doubao-vision-pro",
      "doubao-1-5-vision-pro",
      "llava-1.5",
      "pixtral-12b",
      "internvl2-8b",
      "minicpm-v-2.6",
      "step-1v",
      "yi-vision",
    ];
    for (const id of visionIds) {
      expect(modelSupportsVision(id)).toBe(true);
    }
  });

  test("returns false for clearly non-vision models", () => {
    const nonVisionIds = [
      "deepseek-chat",
      "deepseek-reasoner",
      "deepseek-coder",
      "gpt-3.5-turbo",
      "text-embedding-3-small",
    ];
    for (const id of nonVisionIds) {
      expect(modelSupportsVision(id)).toBe(false);
    }
  });

  test("conservatively returns false for unknown / empty ids", () => {
    expect(modelSupportsVision("")).toBe(false);
    expect(modelSupportsVision("some-random-llm-v2")).toBe(false);
    expect(modelSupportsVision("mistral-large")).toBe(false);
    expect(modelSupportsVision("llama-3-70b")).toBe(false);
  });

  test("non-vision markers take precedence over vision markers", () => {
    // deepseek-chat contains no vision marker but is explicitly excluded;
    // ensure exclusion also guards lookalike combinations.
    expect(modelSupportsVision("gpt-3.5-turbo-instruct")).toBe(false);
  });
});
