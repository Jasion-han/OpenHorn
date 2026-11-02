export const HISTORY_MAX_TOKENS = 16_000;

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

export function truncateHistory(
  history: Array<{ role: "user" | "assistant"; content: string }>,
  maxTokens: number,
): Array<{ role: "user" | "assistant"; content: string }> {
  if (history.length === 0) return [];
  const messageTokens = (message: { content: string }) => estimateTokens(message.content) + 10;
  if (history.reduce((sum, message) => sum + messageTokens(message), 0) <= maxTokens) {
    return [...history];
  }
  const omission = (count: number) => ({
    role: "user" as const,
    content: `[${count} earlier messages omitted]`,
  });
  // The notice is part of the history budget, including when no old message
  // fits. Never silently return an empty history after dropping prior turns.
  let totalTokens = 0;
  const kept: typeof history = [];
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i];
    if (!msg) continue;
    const tokens = messageTokens(msg);
    const requiredNotice = i > 0 ? messageTokens(omission(i)) : 0;
    if (totalTokens + tokens + requiredNotice > maxTokens) break;
    totalTokens += tokens;
    kept.unshift(msg);
  }
  if (kept.length < history.length) {
    const skipped = history.length - kept.length;
    const noticeTokens = messageTokens(omission(skipped));
    if (totalTokens + noticeTokens > maxTokens) {
      throw new Error("History context budget is too small for an omission notice");
    }
    kept.unshift(omission(skipped));
  }
  return kept;
}

export type HistoryMessage = { role: "user" | "assistant"; content: string };

/**
 * Turns (already truncated) conversation history plus the current prompt into a
 * sequence the chat APIs accept as real multi-turn messages:
 *
 * - empty / whitespace-only entries are dropped;
 * - adjacent same-role entries are merged with `\n\n`;
 * - leading assistant entries are dropped (the sequence must open with user);
 * - a trailing user entry is merged into the current prompt, so the returned
 *   `messages` always end with an assistant turn and the caller appends the
 *   current prompt as the final user message — strict alternation holds.
 *
 * Sending history this way (instead of one `User: … Assistant: …` transcript
 * blob) stops models from treating the transcript as text to continue and
 * echoing the previous answer.
 */
export function buildHistoryMessages(
  history: HistoryMessage[] | undefined,
  prompt: string,
): { messages: HistoryMessage[]; prompt: string } {
  const messages: HistoryMessage[] = [];
  for (const entry of history ?? []) {
    if (!entry.content.trim()) continue;
    const last = messages[messages.length - 1];
    if (last && last.role === entry.role) {
      last.content = `${last.content}\n\n${entry.content}`;
      continue;
    }
    if (!last && entry.role === "assistant") continue;
    messages.push({ role: entry.role, content: entry.content });
  }
  const tail = messages[messages.length - 1];
  if (tail && tail.role === "user") {
    messages.pop();
    return { messages, prompt: `${tail.content}\n\n${prompt}` };
  }
  return { messages, prompt };
}
