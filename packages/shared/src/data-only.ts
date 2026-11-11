import { LIBRARY_SYSTEM_TAG } from "./library";
import { REVIEW_JSON_SYSTEM_TAG } from "./reviews";
export const DATA_ONLY_PROMPT_TAGS = [REVIEW_JSON_SYSTEM_TAG, LIBRARY_SYSTEM_TAG] as const;

export function isDataOnlyPrompt(prompt: string | null | undefined): boolean {
  const value = prompt?.trimStart() ?? "";
  return DATA_ONLY_PROMPT_TAGS.some((tag) => value.startsWith(tag));
}
