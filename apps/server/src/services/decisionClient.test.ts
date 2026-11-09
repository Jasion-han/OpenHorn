import { expect, test } from "bun:test";
import { JEV_MODEL, JEV_RESOLVED_MODEL } from "shared/decisions";
import type { DecisionRequest } from "shared/types";
import { createDecisionClient, JEV_ENDPOINT } from "./decisionClient";

const request: DecisionRequest = {
  model: JEV_MODEL,
  state: { text: "Synthetic" },
  questions: { relevant: { type: "noul", instructions: "Is the text relevant?" } },
};
const good = {
  id: "synthetic-request",
  model: JEV_RESOLVED_MODEL,
  answers: { relevant: { type: "noul", noul: 0.85 } },
  usage: { input_tokens: 100, output_tokens: 10, cost: 0.0000042 },
};
function harness(overrides: Partial<Parameters<typeof createDecisionClient>[0]> = {}) {
  let calls = 0,
    reserves = 0,
    settlements = 0;
  const evaluate = createDecisionClient({
    apiKey: () => "synthetic-private-key",
    allowed: async () => true,
    reserve: async () => {
      reserves++;
      return { id: "reservation", day: "2026-11-09" };
    },
    settle: async () => {
      settlements++;
    },
    fetchImpl: async (url, init) => {
      calls++;
      expect(url).toBe(JEV_ENDPOINT);
      expect(init.redirect).toBe("error");
      return Response.json(good);
    },
    ...overrides,
  });
  return { evaluate, counts: () => ({ calls, reserves, settlements }) };
}
test("decisions share in-flight requests and cache successful exact inputs per user/feature", async () => {
  const h = harness();
  const [a, b] = await Promise.all([
    h.evaluate("u", "rerank", request),
    h.evaluate("u", "rerank", request),
  ]);
  expect(a.ok).toBe(true);
  expect(b.ok).toBe(true);
  expect(a.ok && b.ok && a.evaluation.billedCostUsd + b.evaluation.billedCostUsd).toBe(
    good.usage.cost,
  );
  const cached = await h.evaluate("u", "rerank", request);
  expect(cached.ok && cached.evaluation.cached).toBe(true);
  expect(cached.ok && cached.evaluation.billedCostUsd).toBe(0);
  expect(h.counts()).toEqual({ calls: 1, reserves: 1, settlements: 1 });
  await h.evaluate("other", "rerank", request);
  expect(h.counts().calls).toBe(2);
  expect(JSON.stringify(a).includes("synthetic-private-key")).toBe(false);
});
test("disabled, missing keys and exhausted budgets do not contact OpenRouter", async () => {
  for (const overrides of [
    { allowed: async () => false },
    { apiKey: () => undefined },
    { reserve: async () => null },
  ]) {
    const h = harness(overrides);
    expect((await h.evaluate("u", "rerank", request)).ok).toBe(false);
    expect(h.counts().calls).toBe(0);
  }
});
test("API failures and malformed answers remain errors and cool down across different payloads", async () => {
  for (const mode of ["http", "shape"]) {
    let now = 100_000,
      calls = 0;
    const h = harness({
      now: () => now,
      fetchImpl: async () => {
        calls++;
        return mode === "http"
          ? new Response("secret upstream body", { status: 429 })
          : Response.json({ ...good, answers: { relevant: { type: "noul", noul: 8 } } });
      },
    });
    const first = await h.evaluate("u", "rerank", request);
    expect(first).toEqual({
      ok: false,
      reason: mode === "http" ? "rate_limited" : "invalid_response",
    });
    await h.evaluate("u", "rerank", { ...request, state: "Different input" });
    expect(calls).toBe(1);
    expect(h.counts().settlements).toBe(0);
    now += 60_001;
    await h.evaluate("u", "rerank", request);
    expect(calls).toBe(2);
  }
});
test("timeout aborts HTTP and leaves the conservative billing reservation unsettled", async () => {
  let aborted = false;
  const h = harness({
    timeoutMs: 5,
    fetchImpl: async (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          aborted = true;
          reject(init.signal?.reason);
        });
      }),
  });
  expect(await h.evaluate("u", "reviews", request)).toEqual({ ok: false, reason: "timeout" });
  expect(aborted).toBe(true);
  expect(h.counts().settlements).toBe(0);
});
test("disabling a feature also prevents previously cached answers from being served", async () => {
  let allowed = true;
  const h = harness({ allowed: async () => allowed });
  await h.evaluate("u", "reviews", request);
  allowed = false;
  expect(await h.evaluate("u", "reviews", request)).toEqual({ ok: false, reason: "disabled" });
});

test("decision state redacts supplied credentials while the fixed HTTP auth header remains separate", async () => {
  let sent: RequestInit | undefined;
  const credential = `sk-or-v1-${"a".repeat(64)}`;
  const h = harness({
    fetchImpl: async (_url, init) => {
      sent = init;
      return Response.json(good);
    },
  });
  const result = await h.evaluate("u", "skills", {
    ...request,
    state: `Configure this key: ${credential}; internal key synthetic-private-key`,
  });
  expect(result.ok).toBe(true);
  expect(String(sent?.body).includes(credential)).toBe(false);
  expect(String(sent?.body).includes("synthetic-private-key")).toBe(false);
  expect((sent?.headers as Record<string, string>).Authorization).toBe(
    "Bearer synthetic-private-key",
  );
});
