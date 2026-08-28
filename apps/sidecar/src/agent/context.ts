export const HISTORY_MAX_TOKENS = 16_000;

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

export function truncateHistory(
  history: Array<{ role: "user" | "assistant"; content: string }>,
  maxTokens: number,
): Array<{ role: "user" | "assistant"; content: string }> {
  let totalTokens = 0;
  const kept: typeof history = [];
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i]!;
    const tokens = estimateTokens(msg.content) + 10;
    if (totalTokens + tokens > maxTokens) break;
    totalTokens += tokens;
    kept.unshift(msg);
  }
  if (kept.length < history.length && kept.length > 0) {
    const skipped = history.length - kept.length;
    kept.unshift({
      role: "user" as const,
      content: `[${skipped} earlier messages omitted]`,
    });
  }
  return kept;
}
