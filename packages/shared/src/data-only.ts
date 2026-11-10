import { LIBRARY_SYSTEM_TAG } from "./library";
import { REVIEW_JSON_SYSTEM_TAG } from "./reviews";
export function isDataOnlyPrompt(prompt: string | null | undefined): boolean {
  const value = prompt?.trimStart() ?? "";
  return value.startsWith(REVIEW_JSON_SYSTEM_TAG) || value.startsWith(LIBRARY_SYSTEM_TAG);
}
