import { agentRunReplyText, assistantMessageContent } from "shared/message-text";

/**
 * Brings an assistant row stored before the reply-text invariant into line
 * with it: the reply lives in the run's `text` steps, `content` is derived from
 * them (`assistantMessageContent`), and a failure lives in `agentRun.error`.
 *
 * Rows that predate the invariant come in three shapes:
 *
 * - **task-backed** (`agentRun.taskId`) with the task still on record — `task`
 *   is given: the text steps are rebuilt from the task's full final_result and
 *   the failure from its latest execution run (the stored content was only the
 *   clipped card preview, or the error string);
 * - **reply in `content` that the text steps lack** — builds before the
 *   timeline stream popped the trailing text steps on completion and kept the
 *   full streamed text in `content`; later builds stripped them altogether;
 *   imports and the legacy session migration kept the final text as the body:
 *   the text (minus leading segments the steps already carry) becomes the
 *   run's closing `text` step. Text in `content` is never dropped;
 * - **failure text in `content`** — `content` repeats `agentRun.error`
 *   (optionally prefixed "Error: "), or the run failed with no error recorded:
 *   the text is the failure the user was shown, so it lives in
 *   `agentRun.error` and `content` keeps only the text steps. A failed run
 *   whose `content` differs from its recorded error kept its partial reply
 *   there (older builds wrote `content || error`) — that is reply text.
 *
 * Pure and idempotent: a row already in line comes back with the identical
 * `agentRun` string, so callers can skip the write by comparing. Rows without a
 * parseable agent run are chat rows and are returned unchanged.
 */
export function normalizeStoredAgentReply(
  row: { content: string; agentRun: string | null },
  task?: { replyText: string; failure?: string },
): { content: string; agentRun: string | null } {
  const run = parseRun(row.agentRun);
  if (!run) return row;

  const steps: unknown[] = Array.isArray(run.steps) ? run.steps : [];
  let next: Record<string, unknown> | null = null;

  if (task) {
    const rebuilt = [
      ...steps.filter((step) => !isTextStep(step)),
      ...(task.replyText ? [{ type: "text", content: task.replyText }] : []),
    ];
    const error = task.failure ?? (typeof run.error === "string" ? run.error : undefined);
    const candidate: Record<string, unknown> = { ...run, steps: rebuilt };
    if (error) candidate.error = error;
    else delete candidate.error;
    if (JSON.stringify(candidate) !== JSON.stringify(run)) next = candidate;
  } else if (row.content.trim() && !agentRunReplyText(run).includes(row.content.trim())) {
    // `content` holds text the run's text steps do not: it must never be
    // dropped by deriving `content` from the steps alone.
    const text = row.content.trim();
    const error = typeof run.error === "string" ? run.error.trim() : "";
    const shownFailure = text.replace(/^Error:\s*/, "");
    if (error && shownFailure === error) {
      // The failure repeated into content; it already lives in agentRun.error.
    } else if (!error && run.status === "failed") {
      next = { ...run, error: shownFailure };
    } else {
      // The reply (or, for an older failed run, the partial reply — those
      // builds kept the streamed text in content and the error in
      // agentRun.error). Builds before the timeline stream also left the
      // earlier text segments as steps and the full streamed text in content,
      // so drop the leading segments the steps already carry.
      const rest = stripLeadingSegments(text, textStepContents(steps));
      if (rest) next = { ...run, steps: [...steps, { type: "text", content: rest }] };
    }
  }

  const agentRun = next ? JSON.stringify(next) : row.agentRun;
  return { content: assistantMessageContent(row.content, agentRun), agentRun };
}

function parseRun(agentRun: string | null): Record<string, unknown> | null {
  if (!agentRun) return null;
  try {
    const parsed: unknown = JSON.parse(agentRun);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function textStepContents(steps: unknown[]): string[] {
  return steps
    .filter(isTextStep)
    .map((step) => (step as { content?: unknown }).content)
    .filter((content): content is string => typeof content === "string")
    .map((content) => content.trim())
    .filter(Boolean);
}

function stripLeadingSegments(text: string, segments: string[]): string {
  let rest = text;
  for (const segment of segments) {
    if (!rest.startsWith(segment)) break;
    rest = rest.slice(segment.length).trimStart();
  }
  return rest;
}

function isTextStep(step: unknown): boolean {
  return Boolean(step && typeof step === "object" && (step as { type?: unknown }).type === "text");
}
