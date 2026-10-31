import type { MessageFinishReason } from "./types";

/**
 * The reply text of an Agent run.
 *
 * Agent answers live in `agentRun.steps[]` as `{ type: "text", content }` steps
 * so the bubble can render them inline in the run timeline. The stored message
 * `content` must still equal that text — search, export, summaries, titles and
 * conversation history all read `content` and nothing else. Every write path
 * therefore derives `content` from the steps through this module.
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
 * The one rule for an assistant message's stored `content`, shared by every
 * writer (desktop store, server sync, task-backed turns, imports, migrations):
 * a message that carries an agent run gets its text steps' reply text — with
 * no fallback to the caller's `content`, so a run without text steps (a failed
 * run, an unfinished task) stores "" and its error lives in `agentRun.error`.
 * A message without an agent run (chat mode) keeps `content` unchanged.
 */
export function assistantMessageContent(content: string, agentRun: unknown): string {
  return parseAgentRun(agentRun) ? agentRunReplyText(agentRun) : content;
}

/**
 * The one rule for an assistant message's stored `finish_reason`, shared by
 * every writer. "stopped" when the writer says so, or when the message carries
 * an agent run the user cancelled — the run status is the agent's own record of
 * the stop, so the column can never disagree with it (and older clients that
 * only send the run still get the column right). Anything else is null: a
 * re-produced reply that finished clears an earlier "stopped".
 */
export function assistantFinishReason(
  finishReason: unknown,
  agentRun: unknown,
): MessageFinishReason | null {
  if (finishReason === "stopped") return "stopped";
  return parseAgentRun(agentRun)?.status === "cancelled" ? "stopped" : null;
}

function parseAgentRun(agentRun: unknown): Record<string, unknown> | null {
  let run = agentRun;
  if (typeof run === "string") {
    try {
      run = JSON.parse(run);
    } catch {
      return null;
    }
  }
  return run && typeof run === "object" && !Array.isArray(run)
    ? (run as Record<string, unknown>)
    : null;
}

function textSteps(agentRun: unknown): string[] {
  const steps = parseAgentRun(agentRun)?.steps;
  if (!Array.isArray(steps)) return [];
  const texts: string[] = [];
  for (const step of steps) {
    if (!step || typeof step !== "object") continue;
    const { type, content } = step as { type?: unknown; content?: unknown };
    if (type === "text" && typeof content === "string") texts.push(content);
  }
  return texts;
}
