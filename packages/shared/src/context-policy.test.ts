import { expect, test } from "bun:test";
import { boundChatContext, estimateContextMessageTokens } from "./context-budget";
import { isValidContextWindow, resolveContextPolicy } from "./context-policy";

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
