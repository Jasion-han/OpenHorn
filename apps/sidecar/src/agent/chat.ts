import { createAdapter, type ChatMessage } from "adapters";
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
  const adapter = createAdapter(input.protocol, input.apiKey, input.baseUrl);

  try {
    const stream = adapter.chatStream({
      model: input.model,
      messages: input.messages,
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
    const message = error instanceof Error ? error.message : "Stream error";
    input.onEvent({ type: "error", content: message });
    return;
  }

  input.onEvent({ type: "done" });
}
