export type HistoryEntry = { role: "user" | "assistant"; content: string };

/**
 * Turns stored messages into the `conversationHistory` a sidecar run replays:
 * user / assistant turns with non-empty `content`. Agent replies carry their
 * answer in `content` too (derived from the run's text steps on every write).
 */
export function buildConversationHistory(
  messages: ReadonlyArray<{ role: string; content?: string | null }>,
): HistoryEntry[] {
  const history: HistoryEntry[] = [];
  for (const m of messages) {
    if (m.role !== "user" && m.role !== "assistant") continue;
    const text = (m.content ?? "").trim();
    if (!text) continue;
    history.push({ role: m.role, content: text });
  }
  return history;
}
