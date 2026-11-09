import { createHash } from "node:crypto";
import { JEV_MAX_REQUEST_BYTES, JEV_MODEL, parseDecisionResponse } from "shared/decisions";
import type { DecisionEvaluation, DecisionRequest, DecisionResult, JevFeature } from "shared/types";
import {
  getJevApiKey,
  getJevPreferences,
  reserveJevRequest,
  settleJevRequest,
} from "./decisionUsageService";

export const JEV_ENDPOINT = "https://openrouter.ai/api/v1/systemone";
export interface DecisionClientDeps {
  apiKey(): string | undefined;
  allowed(userId: string, feature: JevFeature): Promise<boolean>;
  reserve(userId: string): Promise<{ id: string; day: string } | null>;
  settle(userId: string, reservation: { id: string; day: string }, cost: number): Promise<void>;
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
  timeoutMs?: number;
  now?: () => number;
}
export function createDecisionClient(deps: DecisionClientDeps) {
  const now = deps.now ?? Date.now;
  const cache = new Map<string, { until: number; evaluation: DecisionEvaluation }>();
  const failures = new Map<string, number>();
  const pending = new Map<string, Promise<DecisionResult>>();
  const coolDown = (name: string) => {
    while (failures.size >= 256 && !failures.has(name))
      failures.delete(failures.keys().next().value as string);
    failures.set(name, now() + 60_000);
  };
  return async function evaluate(
    userId: string,
    feature: JevFeature,
    request: DecisionRequest,
  ): Promise<DecisionResult> {
    const key = deps.apiKey()?.trim();
    if (!key) return { ok: false, reason: "disabled" };
    try {
      if (!(await deps.allowed(userId, feature))) return { ok: false, reason: "disabled" };
    } catch {
      return { ok: false, reason: "unavailable" };
    }
    // Credentials can appear in a configuration-help prompt or skill description.
    // They are never needed for a semantic judgment; keep auth only in the HTTP header.
    const body = JSON.stringify(request)
      .split(key)
      .join("[redacted]")
      .replace(/\bsk-(?:or-v1-|ant-)?[A-Za-z0-9_-]{16,}\b/g, "[redacted-key]")
      .replace(/\bBearer\s+[A-Za-z0-9._~+/-]{20,}={0,2}/gi, "Bearer [redacted-token]");
    if (
      request.model !== JEV_MODEL ||
      Buffer.byteLength(body, "utf8") > JEV_MAX_REQUEST_BYTES ||
      !Object.keys(request.questions).length ||
      Object.keys(request.questions).length > 100
    )
      return { ok: false, reason: "input_limit" };
    const sentRequest = JSON.parse(body) as DecisionRequest;
    const id = createHash("sha256").update(`${userId}:${feature}:${body}`).digest("hex");
    const hit = cache.get(id);
    if (hit && hit.until > now())
      return { ok: true, evaluation: { ...hit.evaluation, cached: true, billedCostUsd: 0 } };
    if ((failures.get(`${userId}:${feature}`) ?? 0) > now())
      return { ok: false, reason: "unavailable" };
    if (pending.has(id))
      return (pending.get(id) as Promise<DecisionResult>).then((result) =>
        result.ok === true
          ? { ok: true, evaluation: { ...result.evaluation, cached: true, billedCostUsd: 0 } }
          : result,
      );
    for (const [hash, entry] of cache) if (entry.until <= now()) cache.delete(hash);
    for (const [name, until] of failures) if (until <= now()) failures.delete(name);
    const run = (async (): Promise<DecisionResult> => {
      const started = now();
      let reservation: { id: string; day: string } | null;
      try {
        reservation = await deps.reserve(userId);
      } catch {
        return { ok: false, reason: "unavailable" };
      }
      if (!reservation) return { ok: false, reason: "budget" };
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(new DOMException("Decision request timed out", "TimeoutError")),
        deps.timeoutMs ?? (feature === "routeShadow" ? 2_000 : 5_000),
      );
      try {
        const response = await (deps.fetchImpl ?? fetch)(JEV_ENDPOINT, {
          method: "POST",
          redirect: "error",
          headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
          body,
          signal: controller.signal,
        });
        if (!response.ok) {
          void response.body?.cancel().catch(() => {});
          coolDown(`${userId}:${feature}`);
          return { ok: false, reason: response.status === 429 ? "rate_limited" : "unavailable" };
        }
        let parsed: ReturnType<typeof parseDecisionResponse>;
        try {
          parsed = parseDecisionResponse(await response.json(), sentRequest);
        } catch {
          if (controller.signal.aborted) throw controller.signal.reason;
          coolDown(`${userId}:${feature}`);
          return { ok: false, reason: "invalid_response" };
        }
        controller.signal.throwIfAborted();
        // A failed ledger write keeps the conservative reservation across restart.
        await deps.settle(userId, reservation, parsed.usage.costUsd).catch(() => {});
        const evaluation: DecisionEvaluation = {
          ...parsed,
          billedCostUsd: parsed.usage.costUsd,
          cached: false,
          latencyMs: Math.max(0, Math.round(now() - started)),
        };
        while (cache.size >= 256) cache.delete(cache.keys().next().value as string);
        cache.set(id, { until: now() + 10 * 60_000, evaluation });
        return { ok: true, evaluation };
      } catch {
        coolDown(`${userId}:${feature}`);
        return { ok: false, reason: controller.signal.aborted ? "timeout" : "unavailable" };
      } finally {
        clearTimeout(timer);
      }
    })().finally(() => pending.delete(id));
    pending.set(id, run);
    return run;
  };
}
export const evaluateDecision = createDecisionClient({
  apiKey: getJevApiKey,
  allowed: async (userId, feature) => {
    const preferences = await getJevPreferences(userId);
    return preferences.enabled && preferences.features[feature];
  },
  reserve: reserveJevRequest,
  settle: settleJevRequest,
});
