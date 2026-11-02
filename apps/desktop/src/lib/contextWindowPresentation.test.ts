import { expect, test } from "bun:test";
import type { ModelContextMetadata } from "shared/types";
import { contextWindowPresentation } from "./contextWindowPresentation";

test("unknown capacity remains a conservative budget, never a reported model window", () => {
  const unknown = contextWindowPresentation({ model: "unlisted/private-alias" });
  expect(unknown.known).toBe(false);
  expect(unknown.source).toBe("fallback");
  expect(unknown.contextWindow).toBe(32_000);
  expect(unknown.checkedAt).toBe(null);
  const invalid = contextWindowPresentation({
    model: "unlisted/private-alias",
    contextMetadata: { contextWindow: -1, source: "channel", fetchedAt: 0 },
  });
  expect(invalid.known).toBe(false);
  expect(invalid.source).toBe("fallback");
});

test("each discovered source keeps provenance and survives a manual-to-auto reset", () => {
  for (const source of ["channel", "catalog", "runtime"] as const) {
    const contextMetadata: ModelContextMetadata = {
      contextWindow: 1_000_000,
      source,
      fetchedAt: 1_793_606_400_000,
    };
    const automatic = contextWindowPresentation({ model: "gateway/large", contextMetadata });
    expect(automatic.known).toBe(true);
    expect(automatic.source).toBe(source);
    expect(automatic.contextWindow).toBe(1_000_000);
    expect(automatic.checkedAt?.getTime()).toBe(contextMetadata.fetchedAt);
    const manual = contextWindowPresentation({
      model: "gateway/large",
      contextMetadata,
      contextWindow: 128_000,
    });
    expect(manual.source).toBe("configured");
    expect(manual.contextWindow).toBe(128_000);
    const reset = contextWindowPresentation({
      model: "gateway/large",
      contextMetadata,
      contextWindow: null,
    });
    expect(reset.source).toBe(source);
    expect(reset.contextWindow).toBe(1_000_000);
  }
});

test("built-in facts, input-only reports and malformed timestamps stay distinguishable", () => {
  const builtin = contextWindowPresentation({ model: "gpt-6-astra" });
  expect(builtin.source).toBe("model");
  expect(builtin.checkedAt).toBe(null);
  const inputOnly = contextWindowPresentation({
    model: "reported-alias",
    contextMetadata: {
      contextWindow: 1_000_000,
      maxInputTokens: 1_000_000,
      maxOutputTokens: 64_000,
      inputLimitOnly: true,
      source: "channel",
      fetchedAt: Number.MAX_SAFE_INTEGER,
    },
  });
  expect(inputOnly.source).toBe("channel");
  expect(inputOnly.inputLimitOnly).toBe(true);
  expect(inputOnly.checkedAt).toBe(null);
});
