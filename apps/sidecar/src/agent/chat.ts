import {
  type ChatMessage,
  ChatResponseRefusedError,
  ChatStreamTruncatedError,
  createAdapter,
  filterChatProviderState,
  isAnthropicOAuthToken,
} from "adapters";
import { boundChatContext, ChatContextBudgetError } from "shared/context-budget";
import { resolveContextPolicy } from "shared/context-policy";
import type { ModelContextMetadata, NativeWebOptions } from "shared/types";
import { resolveClaudeBillingMarker } from "./anthropic-billing";
import type { AgentEvent } from "./events";

export type RunChatStreamInput = {
  apiKey: string;
  baseUrl?: string;
  protocol: string;
  model: string;
  contextWindow?: number | null;
  contextMetadata?: ModelContextMetadata | null;
  messages: ChatMessage[];
  nativeWeb?: NativeWebOptions;
  abortController: AbortController;
  onEvent: (event: AgentEvent) => void;
};

export async function runChatStream(input: RunChatStreamInput): Promise<void> {
  const policy = resolveContextPolicy(input);
  let messages: ChatMessage[];
  try {
    // The desktop appends its response-format schema after server preparation.
    // Recheck the final payload so those instructions also consume the budget.
    messages = boundChatContext(
      filterChatProviderState(input.messages, input.protocol, input.baseUrl, input.model),
      {
        maxTokens: policy.maxInputTokens,
        maxMessages: policy.maxMessages,
      },
    );
  } catch (error) {
    input.onEvent({
      type: "error",
      content: error instanceof Error ? error.message : String(error),
      ...(error instanceof ChatContextBudgetError ? { errorCode: error.code } : {}),
    });
    return;
  }
  // Claude Code OAuth tokens: the adapter applies the OAuth request rules
  // itself; the sidecar only supplies the billing marker for the local CLI.
  const billingMarker = isAnthropicOAuthToken(input.apiKey)
    ? await resolveClaudeBillingMarker()
    : undefined;
  const adapter = createAdapter(input.protocol, input.apiKey, input.baseUrl, {
    anthropic: { billingMarker },
  });

  let refused = false;
  try {
    const stream = adapter.chatStream({
      model: input.model,
      messages,
      maxTokens: policy.maxOutputTokens,
      signal: input.abortController.signal,
      nativeWeb: input.nativeWeb,
      onMetadata: (metadata) => {
        if (input.abortController.signal.aborted) return;
        if (metadata.refused && !refused) input.onEvent({ type: "clear_streaming_text" });
        refused = metadata.refused === true;
        input.onEvent({ type: "chat_metadata", metadata });
      },
    });

    // Drive the iterator by hand: chatStream reports token usage through the
    // generator's return value, which `for await` discards.
    while (true) {
      const step = await stream.next();
      if (step.done) {
        const usage = step.value;
        if (usage) {
          input.onEvent({
            type: "usage",
            promptTokens: usage.promptTokens,
            completionTokens: usage.completionTokens,
            totalTokens: usage.totalTokens,
          });
        }
        break;
      }
      const chunk = step.value;
      if (typeof chunk !== "string" || chunk.length === 0) continue;
      input.onEvent({ type: "text", content: chunk });
    }
  } catch (error) {
    if (input.abortController.signal.aborted) {
      input.onEvent({ type: "done" });
      return;
    }
    if (error instanceof ChatStreamTruncatedError) {
      if (error.usage) input.onEvent({ type: "usage", ...error.usage });
      input.onEvent({ type: "error", content: error.message, errorCode: error.code });
      return;
    }
    if (error instanceof ChatResponseRefusedError) {
      if (!refused) input.onEvent({ type: "clear_streaming_text" });
      if (error.usage) input.onEvent({ type: "usage", ...error.usage });
      input.onEvent({ type: "error", content: error.message, errorCode: error.code });
      return;
    }
    const message = error instanceof Error ? error.message : "Stream error";
    input.onEvent({ type: "error", content: message });
    return;
  }

  input.onEvent({ type: "done" });
}
