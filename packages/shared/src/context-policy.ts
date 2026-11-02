import type { ModelContextConfig } from "./types";

export const MIN_CONTEXT_WINDOW = 8_192;
export const MAX_CONTEXT_WINDOW = 2_000_000;
export const FALLBACK_CONTEXT_WINDOW = 32_000;

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
  source: "configured" | "model" | "fallback";
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
  const configuredWindow = input.contextWindow;
  const configured = isValidContextWindow(configuredWindow);
  const requested = configured
    ? configuredWindow
    : (capability?.contextWindow ?? FALLBACK_CONTEXT_WINDOW);
  // A gateway override can lower a documented maximum, never increase it.
  const contextWindow = Math.min(requested, capability?.contextWindow ?? MAX_CONTEXT_WINDOW);
  const agent = input.mode === "agent";
  const maxOutputTokens = Math.min(agent ? 16_384 : 4_096, Math.floor(contextWindow / 4));
  const reserveTokens =
    Math.max(1_024, Math.ceil(contextWindow * 0.05)) +
    (agent ? Math.min(32_768, Math.floor(contextWindow / 8)) : 0);
  const maxInputTokens = Math.min(
    contextWindow - maxOutputTokens - reserveTokens,
    capability?.maxInputTokens ?? Number.POSITIVE_INFINITY,
  );
  return {
    contextWindow,
    maxInputTokens,
    maxOutputTokens,
    reserveTokens,
    maxMessages: Math.min(10_000, Math.max(200, Math.floor(maxInputTokens / 64))),
    source: configured ? "configured" : capability ? "model" : "fallback",
  };
}
