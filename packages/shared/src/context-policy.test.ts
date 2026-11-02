import { expect, test } from "bun:test";
import { boundChatContext, estimateContextMessageTokens } from "./context-budget";
import {
  isValidContextWindow,
  normalizeModelContextMetadata,
  resolveContextPolicy,
} from "./context-policy";
import type { ModelContextMetadata } from "./types";

const discovered: ModelContextMetadata = {
  contextWindow: 262_144,
  maxInputTokens: 200_000,
  maxOutputTokens: 1024,
  source: "channel",
  fetchedAt: 1_793_620_000_000,
};

test("reported limits work for other providers and exact namespaced channel model IDs", () => {
  for (const model of [
    "google/gemini-2.5-pro",
    "anthropic/claude-opus-5.5",
    "qwen/custom-alias",
    "deepseek-v4",
  ]) {
    for (const mode of ["chat", "agent"] as const) {
      const policy = resolveContextPolicy({ model, mode, contextMetadata: discovered });
      expect(policy.contextWindow).toBe(262_144);
      expect(policy.maxInputTokens).toBe(200_000);
      expect(policy.maxOutputTokens).toBe(1024);
      expect(policy.source).toBe("channel");
    }
  }
});

test("manual settings cannot bypass reported input/output limits and blank restores discovery", () => {
  const large = resolveContextPolicy({
    model: "alias",
    contextWindow: 1_000_000,
    contextMetadata: discovered,
  });
  expect(large.contextWindow).toBe(262_144);
  expect(large.maxInputTokens).toBe(200_000);
  expect(large.maxOutputTokens).toBe(1024);
  expect(large.source).toBe("configured");
  const small = resolveContextPolicy({
    model: "alias",
    contextWindow: 16_384,
    contextMetadata: discovered,
  });
  expect(small.contextWindow).toBe(16_384);
  expect(small.maxInputTokens < 16_384).toBe(true);
  expect(
    resolveContextPolicy({ model: "alias", contextWindow: null, contextMetadata: discovered })
      .source,
  ).toBe("channel");
});

test("current reports supersede old built-in context while keeping independent input ceilings", () => {
  const policy = resolveContextPolicy({
    model: "gpt-6-astra",
    contextMetadata: { ...discovered, contextWindow: 2_097_152, maxInputTokens: 1_800_000 },
  });
  expect(policy.contextWindow).toBe(2_097_152);
  expect(policy.maxInputTokens).toBe(1_800_000);
  const partial = { contextWindow: 1_050_000, source: "channel" as const, fetchedAt: 0 };
  expect(
    resolveContextPolicy({ model: "gpt-6-astra", contextMetadata: partial }).maxInputTokens,
  ).toBe(922_000);
});

test("cached catalog/runtime provenance survives without assuming every alias has 1M", () => {
  for (const source of ["catalog", "runtime"] as const) {
    expect(
      resolveContextPolicy({ model: "not-in-registry", contextMetadata: { ...discovered, source } })
        .source,
    ).toBe(source);
  }
  expect(resolveContextPolicy({ model: "not-in-registry" }).source).toBe("fallback");
});

test("malformed remote metadata cannot create an unbounded budget", () => {
  for (const value of [
    null,
    [],
    {},
    { ...discovered, contextWindow: "262144" },
    { ...discovered, contextWindow: 16_777_217 },
    { ...discovered, contextWindow: 1024 },
    { ...discovered, maxInputTokens: NaN },
    { ...discovered, maxOutputTokens: 0 },
    { ...discovered, fetchedAt: -1 },
    { ...discovered, source: "guess" },
    { ...discovered, inputLimitOnly: "yes" },
  ]) {
    expect(normalizeModelContextMetadata(value)).toBe(null);
  }
  expect(
    normalizeModelContextMetadata({ ...discovered, rawProviderSecret: "do-not-retain" }),
  ).toEqual(discovered);
  expect(
    normalizeModelContextMetadata({ ...discovered, inputLimitOnly: true })?.inputLimitOnly,
  ).toBe(true);
});

test("verified model windows respect distinct input ceilings and output reserves", () => {
  const chat = resolveContextPolicy({ model: "gpt-6-astra" });
  const agent = resolveContextPolicy({ model: "gpt-6-astra", mode: "agent" });
  expect(chat.contextWindow).toBe(1_050_000);
  expect(chat.maxInputTokens).toBe(922_000);
  expect(chat.maxOutputTokens).toBe(4096);
  expect(agent.maxOutputTokens).toBe(16_384);
  expect(agent.reserveTokens > chat.reserveTokens).toBe(true);
  for (const policy of [chat, agent]) {
    expect(
      policy.maxInputTokens + policy.maxOutputTokens + policy.reserveTokens <= policy.contextWindow,
    ).toBe(true);
  }
});

test("only verified exact IDs gain an automatic large window", () => {
  for (const model of [
    "gpt-5.5",
    "gpt-5.4-2026-03-05",
    "gpt-4.1-2025-04-14",
    "claude-opus-5-5",
    "claude-sonnet-5-5",
    "claude-haiku-5-5",
  ]) {
    expect(resolveContextPolicy({ model }).contextWindow >= 1_000_000).toBe(true);
  }
  for (const model of [
    "unknown",
    "claude-sonnet-4-5",
    "prefix-gpt-6-astra",
    "gpt-6-astra-extra",
    "gpt-5.5-2099-01-01",
    "toString",
    "__proto__",
  ]) {
    expect(resolveContextPolicy({ model, protocol: "openai" }).source).toBe("fallback");
    expect(resolveContextPolicy({ model }).contextWindow).toBe(32_000);
  }
});

test("channel overrides can describe aliases or lower gateway ceilings", () => {
  expect(
    resolveContextPolicy({ model: "gateway-alias", contextWindow: 1_000_000 }).contextWindow,
  ).toBe(1_000_000);
  expect(resolveContextPolicy({ model: "gpt-6-astra", contextWindow: 128_000 }).contextWindow).toBe(
    128_000,
  );
  const known = resolveContextPolicy({ model: "gpt-6-astra", contextWindow: 2_000_000 });
  expect(known.contextWindow).toBe(1_050_000);
  expect(known.maxInputTokens).toBe(922_000);
  const small = resolveContextPolicy({ model: "alias", contextWindow: 8192, mode: "agent" });
  expect(small.maxInputTokens > 0).toBe(true);
});

test("malformed capacities cannot disable budgeting", () => {
  for (const value of [0, -1, 8191, 2_000_001, 1.5, NaN, Infinity, "1000000", undefined, null]) {
    expect(isValidContextWindow(value)).toBe(false);
  }
  for (const value of [8192, 128_000, 1_000_000, 2_000_000])
    expect(isValidContextWindow(value)).toBe(true);
  expect(resolveContextPolicy({ model: "unknown", contextWindow: NaN }).source).toBe("fallback");
});

test("large policy retains a request above 32K and histories above 200 messages", () => {
  const policy = resolveContextPolicy({ model: "gpt-6-astra" });
  const history = Array.from({ length: 400 }, (_, index) => ({
    role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
    content: `turn ${index}`,
  }));
  const current = { role: "user" as const, content: "x".repeat(160_000) };
  const messages = [...history, current];
  const bounded = boundChatContext(messages, {
    maxTokens: policy.maxInputTokens,
    maxMessages: policy.maxMessages,
  });
  expect(bounded).toEqual(messages);
  const small = resolveContextPolicy({ model: "unknown" });
  expect(() =>
    boundChatContext(messages, { maxTokens: small.maxInputTokens, maxMessages: small.maxMessages }),
  ).toThrow();
});

test("CJK and emoji estimates no longer use the ASCII compression ratio", () => {
  expect(estimateContextMessageTokens({ role: "user", content: "中".repeat(1000) })).toBe(2010);
  expect(estimateContextMessageTokens({ role: "user", content: "😀".repeat(1000) })).toBe(4010);
  expect(estimateContextMessageTokens({ role: "user", content: "x".repeat(3500) })).toBe(1010);
});
