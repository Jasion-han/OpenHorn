/**
 * The readable text of a stored chat message.
 *
 * Agent-mode replies keep their answer only in `agentRun.steps[]` as
 * `{ type: "text", content }` steps — `content` stays empty. Anything that
 * replays a conversation (history for the next turn, copy-to-clipboard) must
 * read through this, or every Agent answer silently disappears and the model
 * re-answers questions it already answered.
 *
 * Non-empty `content` wins. Otherwise the `text` steps are joined with a blank
 * line; reasoning / thinking / tool steps are never included. `agentRun` may be
 * the parsed object (desktop) or the raw JSON column (server rows).
 */
export function messageText(message: { content?: string | null; agentRun?: unknown }): string {
  const content = (message.content ?? "").trim();
  if (content) return content;
  const steps = agentRunSteps(message.agentRun);
  return steps
    .filter(
      (step): step is { type: "text"; content: string } =>
        !!step &&
        typeof step === "object" &&
        (step as { type?: unknown }).type === "text" &&
        typeof (step as { content?: unknown }).content === "string",
    )
    .map((step) => step.content.trim())
    .filter(Boolean)
    .join("\n\n");
}

function agentRunSteps(agentRun: unknown): unknown[] {
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
  return Array.isArray(steps) ? steps : [];
}
