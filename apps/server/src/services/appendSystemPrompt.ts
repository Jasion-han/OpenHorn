import { REVIEW_JSON_SYSTEM_TAG } from "shared/reviews";
import { mergeSystemPromptParts } from "./responseStyle";

/**
 * Per-request system-prompt addendum supplied by the client (e.g. the desktop
 * generative-UI section on regenerate / edit). It only shapes the single LLM
 * call it arrives with and is never persisted.
 */
export const APPEND_SYSTEM_PROMPT_MAX_LENGTH = 32_000;

/** `error` is set when the value must be rejected; otherwise `value` is the addendum (if any). */
export type AppendSystemPromptParseResult = { value?: string; error?: string };

/** Absent / non-string / blank → ignored; over the cap → rejected. */
export function parseAppendSystemPrompt(raw: unknown): AppendSystemPromptParseResult {
  if (typeof raw !== "string") return {};
  const value = raw.trim();
  if (!value) return {};
  if (value.length > APPEND_SYSTEM_PROMPT_MAX_LENGTH) {
    return { error: "appendSystemPrompt is too long" };
  }
  return { value };
}

/** Appends the addendum after the effective prompt; unchanged when there is none. */
export function withAppendedSystemPrompt(
  effectiveSystemPrompt: string | null | undefined,
  appendSystemPrompt: string | null | undefined,
): string | null {
  if (effectiveSystemPrompt?.trimStart().startsWith(REVIEW_JSON_SYSTEM_TAG))
    return effectiveSystemPrompt;
  return mergeSystemPromptParts(effectiveSystemPrompt, appendSystemPrompt);
}
