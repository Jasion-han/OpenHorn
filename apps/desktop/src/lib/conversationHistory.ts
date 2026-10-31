import { messageText } from "shared/message-text";

export type HistoryEntry = { role: "user" | "assistant"; content: string };

/**
 * Turns stored messages into the `conversationHistory` a sidecar run replays.
 * Agent answers live in `agentRun` text steps with an empty `content`, so the
 * text is read through `messageText` — reading `content` alone dropped every
 * Agent reply and made the model re-answer earlier questions.
 */
export function buildConversationHistory(
  messages: ReadonlyArray<{ role: string; content?: string | null; agentRun?: unknown }>,
): HistoryEntry[] {
  const history: HistoryEntry[] = [];
  for (const m of messages) {
    if (m.role !== "user" && m.role !== "assistant") continue;
    const text = messageText(m);
    if (!text) continue;
    history.push({ role: m.role, content: text });
  }
  return history;
}
