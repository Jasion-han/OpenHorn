import { normalizeModelContextMetadata, resolveContextPolicy } from "shared/context-policy";
import type { ModelContextConfig } from "shared/types";

export function contextWindowPresentation(
  input: ModelContextConfig & { model: string; protocol?: string },
) {
  const policy = resolveContextPolicy(input);
  const metadata = normalizeModelContextMetadata(input.contextMetadata);
  const checkedAt = metadata ? new Date(metadata.fetchedAt) : null;
  return {
    contextWindow: policy.contextWindow,
    source: policy.source,
    known: policy.source !== "fallback",
    inputLimitOnly: metadata?.inputLimitOnly === true,
    checkedAt: checkedAt && Number.isFinite(checkedAt.getTime()) ? checkedAt : null,
  };
}
