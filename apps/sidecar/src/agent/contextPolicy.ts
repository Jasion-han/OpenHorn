import {
  boundChatContext,
  ChatContextBudgetError,
  estimateContextMessageTokens,
} from "shared/context-budget";
import { resolveContextPolicy } from "shared/context-policy";
import type { HistoryMessage } from "./context";

export interface AgentContextInput {
  model?: string;
  protocol?: string;
  contextWindow?: number | null;
  conversationHistory?: HistoryMessage[];
}

export interface AgentContextParts {
  prompt: string;
  systemPrompt?: string;
  tools?: unknown;
  imageCount?: number;
}

function fixedMessages(parts: Omit<AgentContextParts, "prompt">) {
  const messages: Array<{ role: "system"; content: string }> = [];
  if (parts.systemPrompt) messages.push({ role: "system", content: parts.systemPrompt });
  if (parts.tools) messages.push({ role: "system", content: JSON.stringify(parts.tools) });
  return messages;
}

/** Reserve the complete current request before selecting complete older turns. */
export function boundAgentHistory(
  input: AgentContextInput,
  parts: AgentContextParts,
): HistoryMessage[] {
  const policy = resolveContextPolicy({ ...input, model: input.model ?? "", mode: "agent" });
  const system = fixedMessages(parts);
  const current = { role: "user" as const, content: parts.prompt };
  const history = input.conversationHistory ?? [];
  const maxTokens = policy.maxInputTokens - (parts.imageCount ?? 0) * 1_024;
  // Keep legacy orphan history byte-for-byte only when no truncation is needed.
  // Once trimming is required the shared selector keeps complete user turns.
  if (
    history.length + system.length + 1 <= policy.maxMessages &&
    [...system, ...history, current].reduce(
      (sum, message) => sum + estimateContextMessageTokens(message),
      0,
    ) <= maxTokens
  ) {
    return [...history];
  }
  const bounded = boundChatContext([...system, ...history, current], {
    maxTokens,
    maxMessages: policy.maxMessages,
  });
  // The selector's extra system message is its omission notice. External
  // runtimes serialize it as context; Direct/Claude require a user-first history.
  return bounded.slice(system.length, -1).map((message) => ({
    role: message.role === "assistant" ? "assistant" : "user",
    content: message.content,
  }));
}

/** Tool transcripts are atomic: reject growth rather than break tool/result pairs. */
export function assertAgentContext(
  input: AgentContextInput,
  parts: Omit<AgentContextParts, "prompt">,
  messages: Array<{ role: string; content: unknown }>,
): void {
  const policy = resolveContextPolicy({ ...input, model: input.model ?? "", mode: "agent" });
  const estimated = [...fixedMessages(parts), ...messages].reduce(
    (sum, message) =>
      sum +
      estimateContextMessageTokens({
        role: "user",
        content: Array.isArray(message.content)
          ? message.content.map((part) => {
              if (typeof part === "object" && part !== null && part.type === "image")
                return { type: "image" };
              if (typeof part === "object" && part !== null && part.type === "text") return part;
              return { type: "text", text: JSON.stringify(part) };
            })
          : typeof message.content === "string"
            ? message.content
            : JSON.stringify(message.content),
      }),
    (parts.imageCount ?? 0) * 1_024,
  );
  if (estimated > policy.maxInputTokens) throw new ChatContextBudgetError();
}
