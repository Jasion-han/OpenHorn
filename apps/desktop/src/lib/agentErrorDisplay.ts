import type { ApiProviderErrorKind } from "../types/chat";
import { sanitizeDisplayContent } from "./citations";
import { getAgentErrorLabel } from "./i18n/agent";

export type AgentErrorDisplayMetadata = {
  errorCode?: ApiProviderErrorKind;
  retryable?: boolean;
};

/**
 * Translates a structured agent error code into a Chinese label by looking
 * it up in the i18n dictionary. This is the *only* path the desktop client
 * uses for translating agent errors — string-matching translation has been
 * removed in favour of server-emitted structured metadata.
 */
export function formatStructuredAgentError(
  errorCode: ApiProviderErrorKind | undefined,
  retryable?: boolean,
): string | null {
  return getAgentErrorLabel(errorCode ?? null, retryable);
}

/**
 * Normalizes a piece of upstream agent text for display.
 *
 * Two paths only:
 *   1. Real upstream content exists → sanitize and return as-is. Whatever
 *      language the model / runtime used is the truth; we never invent a
 *      Chinese substitution.
 *   2. No upstream content but we received a structured `errorCode` →
 *      look up the matching Chinese label from the i18n dictionary.
 *
 * Returns `null` when neither path produces something meaningful.
 */
export function normalizeAgentDisplayText(
  content: string | null | undefined,
  metadata?: AgentErrorDisplayMetadata,
): string | null {
  const raw = sanitizeDisplayContent(content ?? "")
    .trim()
    .replace(/\s+/g, " ");
  const structured = formatStructuredAgentError(metadata?.errorCode, metadata?.retryable);

  if (raw) return raw;
  return structured ?? null;
}
