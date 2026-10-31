/**
 * The reply text of an Agent run.
 *
 * Agent answers stream into `agentRun.steps[]` as `{ type: "text", content }`
 * steps so the bubble can render them inline in the run timeline. The stored
 * message `content` must still equal that text — search, export, summaries,
 * titles and conversation history all read `content` and nothing else. Every
 * write path therefore derives `content` from the steps through this module
 * instead of leaving it empty.
 *
 * The text steps are trimmed, empty ones dropped, and the rest joined with a
 * blank line; reasoning / thinking / tool steps are never included. `agentRun`
 * may be the parsed object (desktop) or the raw JSON column (server rows).
 */
export function agentRunReplyText(agentRun: unknown): string {
  return textSteps(agentRun)
    .map((content) => content.trim())
    .filter(Boolean)
    .join("\n\n");
}

/** True when the run carries at least one `text` step (even an empty one). */
export function hasAgentReplyTextSteps(agentRun: unknown): boolean {
  return textSteps(agentRun).length > 0;
}

/**
 * The `content` to store for an assistant message. A run that produced text
 * steps owns the reply text, so `content` is derived from them whatever the
 * caller passed. A run without text steps (server task-backed turns store a
 * task summary, failed runs store nothing) keeps the given `content`.
 */
export function agentReplyContent(content: string, agentRun: unknown): string {
  return hasAgentReplyTextSteps(agentRun) ? agentRunReplyText(agentRun) : content;
}

function textSteps(agentRun: unknown): string[] {
  let run = agentRun;
  if (typeof run === "string") {
    try {
      run = JSON.parse(run);
    } catch {
      return [];
    }
  }
  if (!run || typeof run !== "object") return [];
  const steps = (run as { steps?: unknown }).steps;
  if (!Array.isArray(steps)) return [];
  const texts: string[] = [];
  for (const step of steps) {
    if (!step || typeof step !== "object") continue;
    const { type, content } = step as { type?: unknown; content?: unknown };
    if (type === "text" && typeof content === "string") texts.push(content);
  }
  return texts;
}
