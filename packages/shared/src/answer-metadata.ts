import type { ProviderChatMetadata } from "./types";

/** Answer-model metadata cannot replace evidence from the independently selected search source. */
export function answerModelMetadata(metadata: ProviderChatMetadata): ProviderChatMetadata {
  return {
    ...(metadata.providerState ? { providerState: metadata.providerState } : {}),
    ...(metadata.refused !== undefined ? { refused: metadata.refused } : {}),
  };
}
