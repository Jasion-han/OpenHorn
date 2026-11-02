import { isValidContextWindow } from "shared/context-policy";
import type { ChannelModel } from "../types/chat";

export type ContextWindowDraft = { valid: true; value: number | null } | { valid: false };

/** Blank explicitly restores automatic resolution; never coerce invalid input to zero. */
export function parseContextWindowDraft(draft: string): ContextWindowDraft {
  const text = draft.trim();
  if (!text) return { valid: true, value: null };
  if (!/^\d+$/.test(text)) return { valid: false };
  const value = Number(text);
  return isValidContextWindow(value) ? { valid: true, value } : { valid: false };
}

/** Every list update must retain each selected model's explicit capacity. */
export function channelModelUpdates(
  models: ReadonlyArray<
    Pick<ChannelModel, "modelId" | "displayName" | "enabled" | "isDefault" | "contextWindow">
  >,
) {
  return models.map((model) => ({
    modelId: model.modelId,
    displayName: model.displayName,
    enabled: model.enabled,
    isDefault: model.isDefault,
    contextWindow: model.contextWindow ?? null,
  }));
}
