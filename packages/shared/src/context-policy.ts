import type { ModelContextConfig, ModelContextMetadata } from "./types";

export const MIN_CONTEXT_WINDOW = 8_192;
export const MAX_CONTEXT_WINDOW = 2_000_000;
export const FALLBACK_CONTEXT_WINDOW = 32_000;
export const MAX_DISCOVERED_CONTEXT_WINDOW = 16_777_216;

type Capability = { contextWindow: number; maxInputTokens?: number };

// Documented capacities, not protocol-wide guesses. Unlisted aliases can be
// configured per channel model. See the context-window spec for source URLs.
const MODEL_CAPABILITIES: Record<string, Capability> = {
  "gpt-6-astra": { contextWindow: 1_050_000, maxInputTokens: 922_000 },
  "gpt-5.5": { contextWindow: 1_050_000 },
  "gpt-5.5-2026-04-23": { contextWindow: 1_050_000 },
  "gpt-5.4": { contextWindow: 1_050_000 },
  "gpt-5.4-2026-03-05": { contextWindow: 1_050_000 },
  "gpt-4.1": { contextWindow: 1_047_576 },
  "gpt-4.1-2025-04-14": { contextWindow: 1_047_576 },
  "claude-opus-5-5": { contextWindow: 1_000_000 },
  "claude-sonnet-5-5": { contextWindow: 1_000_000 },
  "claude-haiku-5-5": { contextWindow: 1_000_000 },
};

export interface ContextPolicy {
  contextWindow: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  maxMessages: number;
  reserveTokens: number;
  source: "configured" | "model" | "fallback" | ModelContextMetadata["source"];
}

/** Validate cached/remote metadata at every trust boundary; retain no raw fields. */
export function normalizeModelContextMetadata(value: unknown): ModelContextMetadata | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const positiveLimit = (limit: unknown): limit is number =>
    typeof limit === "number" &&
    Number.isSafeInteger(limit) &&
    limit >= 1 &&
    limit <= MAX_DISCOVERED_CONTEXT_WINDOW;
  if (
    !positiveLimit(record.contextWindow) ||
    record.contextWindow < 4096 ||
    (record.source !== "channel" && record.source !== "catalog" && record.source !== "runtime") ||
    typeof record.fetchedAt !== "number" ||
    !Number.isSafeInteger(record.fetchedAt) ||
    record.fetchedAt < 0 ||
    (record.maxInputTokens !== undefined && !positiveLimit(record.maxInputTokens)) ||
    (record.maxOutputTokens !== undefined && !positiveLimit(record.maxOutputTokens)) ||
    (record.inputLimitOnly !== undefined && typeof record.inputLimitOnly !== "boolean")
  )
    return null;
  return {
    contextWindow: record.contextWindow,
    source: record.source,
    fetchedAt: record.fetchedAt,
    ...(record.maxInputTokens !== undefined
      ? { maxInputTokens: record.maxInputTokens as number }
      : {}),
    ...(record.maxOutputTokens !== undefined
      ? { maxOutputTokens: record.maxOutputTokens as number }
      : {}),
    ...(record.inputLimitOnly !== undefined
      ? { inputLimitOnly: record.inputLimitOnly as boolean }
      : {}),
  };
}

export function isValidContextWindow(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= MIN_CONTEXT_WINDOW &&
    value <= MAX_CONTEXT_WINDOW
  );
}

/** Resolve once per turn; all transports must use the selected model's policy. */
export function resolveContextPolicy(
  input: ModelContextConfig & { model: string; protocol?: string; mode?: "chat" | "agent" },
): ContextPolicy {
  const model = input.model.trim().toLowerCase();
  const capability = Object.hasOwn(MODEL_CAPABILITIES, model)
    ? MODEL_CAPABILITIES[model]
    : undefined;
  const metadata = normalizeModelContextMetadata(input.contextMetadata);
  const configuredWindow = input.contextWindow;
  const configured = isValidContextWindow(configuredWindow);
  const requested = configured
    ? configuredWindow
    : (metadata?.contextWindow ?? capability?.contextWindow ?? FALLBACK_CONTEXT_WINDOW);
  // Current channel reports supersede the built-in snapshot. Manual settings
  // can lower a reported ceiling, but cannot bypass its input/output limits.
  const contextWindow = Math.min(
    requested,
    metadata?.contextWindow ?? capability?.contextWindow ?? MAX_DISCOVERED_CONTEXT_WINDOW,
  );
  const agent = input.mode === "agent";
  const maxOutputTokens = Math.min(
    agent ? 16_384 : 4_096,
    Math.floor(contextWindow / 4),
    metadata?.maxOutputTokens ?? Number.POSITIVE_INFINITY,
  );
  const reserveTokens =
    Math.max(1_024, Math.ceil(contextWindow * 0.05)) +
    (agent ? Math.min(32_768, Math.floor(contextWindow / 8)) : 0);
  const maxInputTokens = Math.min(
    contextWindow - maxOutputTokens - reserveTokens,
    metadata?.maxInputTokens ?? capability?.maxInputTokens ?? Number.POSITIVE_INFINITY,
  );
  return {
    contextWindow,
    maxInputTokens,
    maxOutputTokens,
    reserveTokens,
    maxMessages: Math.min(10_000, Math.max(200, Math.floor(maxInputTokens / 64))),
    source: configured
      ? "configured"
      : metadata
        ? metadata.source
        : capability
          ? "model"
          : "fallback",
  };
}
