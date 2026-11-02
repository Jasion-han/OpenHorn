import type { ChatMessage } from "adapters";
import { type AgentContextInput, boundAgentHistory } from "./contextPolicy";

/** External runtimes accept one user string; retain the history as explicitly labeled context. */
export function withConversationHistory(
  prompt: string,
  history?: Array<{ role: "user" | "assistant"; content: string }>,
  context?: AgentContextInput & { systemPrompt?: string },
): string {
  const kept = context
    ? boundAgentHistory(
        { ...context, conversationHistory: history },
        { prompt, systemPrompt: context.systemPrompt },
      )
    : (history ?? []);
  if (!kept.length) return prompt;
  return `${kept.map((message) => `${message.role === "user" ? "User" : "Assistant"}: ${message.content}`).join("\n\n")}\n\n---\n\nUser: ${prompt}`;
}

/** ACP has no system-role field. Instructions are explicit, per-request context, never a fake role. */
export function withRunInstructions(prompt: string, instructions?: string): string {
  if (!instructions?.trim()) return prompt;
  return [
    "[OpenHorn app instructions for this request only]",
    instructions.trim(),
    "[End app instructions]",
    "",
    "[User request and conversation context]",
    prompt,
    "[End user request]",
  ].join("\n");
}

function textContent(content: ChatMessage["content"]): string {
  return typeof content === "string"
    ? content
    : content
        .filter((part) => part.type === "text")
        .map((part) => part.text ?? "")
        .join("");
}

/** Preserve system/UI instructions and earlier chat turns on Codex OAuth's exec transport. */
export function codexChatContext(messages: ChatMessage[]): {
  prompt: string;
  systemPrompt?: string;
} {
  const system = messages
    .filter((message) => message.role === "system")
    .map((message) => textContent(message.content))
    .filter((text) => text.trim())
    .join("\n\n");
  const turns = messages.filter(
    (message): message is ChatMessage & { role: "user" | "assistant" } =>
      message.role === "user" || message.role === "assistant",
  );
  let currentIndex = turns.length - 1;
  while (currentIndex >= 0 && turns[currentIndex]?.role !== "user") currentIndex--;
  const current = turns[currentIndex];
  const history = turns.slice(0, Math.max(currentIndex, 0)).map((message) => ({
    role: message.role,
    content: textContent(message.content),
  }));
  return {
    prompt: withConversationHistory(current ? textContent(current.content) : "", history),
    ...(system ? { systemPrompt: system } : {}),
  };
}
