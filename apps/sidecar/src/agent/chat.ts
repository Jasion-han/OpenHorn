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

  let content = "";
  try {
    const stream = adapter.chatStream({
      model: input.model,
      messages: input.messages,
      maxTokens: 4096,
      signal: input.abortController.signal,
    });

    for await (const chunk of stream) {
      if (typeof chunk !== "string" || chunk.length === 0) continue;
      content += chunk;
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
