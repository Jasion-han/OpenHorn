import {
  type ChatMessage,
  ChatStreamTruncatedError,
  createAdapter,
  isAnthropicOAuthToken,
} from "adapters";
import { boundChatContext, ChatContextBudgetError } from "shared/context-budget";
import { resolveClaudeBillingMarker } from "./anthropic-billing";
import type { AgentEvent } from "./events";

export type RunChatStreamInput = {
  apiKey: string;
  baseUrl?: string;
  protocol: string;
  model: string;
  messages: ChatMessage[];
  abortController: AbortController;
  onEvent: (event: AgentEvent) => void;
};

export async function runChatStream(input: RunChatStreamInput): Promise<void> {
  let messages: ChatMessage[];
  try {
    // The desktop appends its response-format schema after server preparation.
    // Recheck the final payload so those instructions also consume the budget.
    messages = boundChatContext(input.messages);
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

  try {
    const stream = adapter.chatStream({
      model: input.model,
      messages,
      maxTokens: 4096,
      signal: input.abortController.signal,
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
    const message = error instanceof Error ? error.message : "Stream error";
    input.onEvent({ type: "error", content: message });
    return;
  }

  input.onEvent({ type: "done" });
}
