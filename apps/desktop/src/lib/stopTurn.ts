import { assistantMessageContent } from "shared/message-text";
import type { ApiAgentRun, Message } from "../types/chat";

/**
 * What "Stop" means for a turn: stop generating — never "undo this turn".
 *
 * The user's question is the user's data and whatever the model already
 * produced is a result that has been paid for, so a stopped turn is persisted
 * like any other: the question as sent, the reply as far as it got. An agent
 * reply carries `agentRun.status = "cancelled"` so it reads as stopped after a
 * reload too. The one exception is a regenerate stopped before it produced
 * anything: nothing new exists, so the previous reply stays.
 *
 * Pure helpers only — the run hook and the chat area apply them.
 */

const IN_PROGRESS: ReadonlyArray<ApiAgentRun["status"]> = [
  "partial",
  "running",
  "awaiting_approval",
];

export function isRunInProgress(run: Pick<ApiAgentRun, "status"> | undefined | null): boolean {
  return Boolean(run && IN_PROGRESS.includes(run.status));
}

/** A run produced something worth showing: a step of any kind, or a recorded failure. */
export function runHasOutput(run: Pick<ApiAgentRun, "steps" | "error"> | undefined | null) {
  return Boolean(run?.error) || (run?.steps?.length ?? 0) > 0;
}

/**
 * The run as it stands once stopped: an in-progress run becomes "cancelled" and
 * keeps every step it recorded. A run that already finished is left alone — its
 * outcome was decided before the stop arrived. A missing run (an agent reply
 * stopped before its first event) becomes an empty cancelled run.
 */
export function stopAgentRun(run: ApiAgentRun | undefined | null): ApiAgentRun {
  if (!run) return { status: "cancelled", summary: "", steps: [] };
  if (!isRunInProgress(run)) return run;
  return { ...run, status: "cancelled", summary: "" };
}

/** Whether a reply message holds anything at all (text, steps, or an error). */
export function replyHasOutput(message: Pick<Message, "content" | "agentRun">): boolean {
  if (message.content?.trim()) return true;
  return runHasOutput(message.agentRun);
}

export type StoppedReplyOutcome =
  /** Nothing new was generated and an earlier reply exists: put it back, write nothing. */
  | { kind: "restore"; reply: Message }
  /** Persist the turn with this reply. */
  | { kind: "persist"; assistantContent: string; agentRun: ApiAgentRun };

/**
 * How a stopped agent turn ends. `previousReply` is the reply this turn replaced
 * (regenerate only — an edit changed the question, so the old reply no longer
 * answers it and is never restored).
 */
export function resolveStoppedAgentReply(input: {
  current: Pick<Message, "content" | "agentRun"> | undefined;
  previousReply?: Message;
}): StoppedReplyOutcome {
  const agentRun = stopAgentRun(input.current?.agentRun);
  if (!runHasOutput(agentRun) && input.previousReply) {
    return { kind: "restore", reply: input.previousReply };
  }
  return {
    kind: "persist",
    agentRun,
    assistantContent: assistantMessageContent(input.current?.content ?? "", agentRun),
  };
}

/** Optimistic ids that never existed server-side. */
export function isPersistedMessageId(id: string | undefined): id is string {
  return Boolean(id && !id.startsWith("temp-") && !id.startsWith("draft-"));
}

/**
 * Which existing rows a sidecar turn writes into. Both ids: the round is updated
 * in place (regenerate / edit-and-resend). Only the user id: an edit of a user
 * message that never got a reply — updated in place, reply inserted after it.
 * Neither: a fresh pair is inserted.
 */
export function resolveSidecarSyncIds(input: {
  existingUserMessageId?: string;
  existingAssistantMessageId?: string;
}): { userMessageId?: string; assistantMessageId?: string } {
  if (!isPersistedMessageId(input.existingUserMessageId)) return {};
  if (!isPersistedMessageId(input.existingAssistantMessageId)) {
    return { userMessageId: input.existingUserMessageId };
  }
  return {
    userMessageId: input.existingUserMessageId,
    assistantMessageId: input.existingAssistantMessageId,
  };
}

/**
 * The closing state line a finished agent run shows, so a reply never renders
 * as a blank bubble:
 *  - "stopped": stopped after producing output (shown under that output);
 *  - "cancelled": stopped before producing anything;
 *  - "noReply": finished without any output and without an error (e.g. a legacy
 *    task that ended without a final result);
 *  - "none": still running, failed with an error (the error line says it), or
 *    an ordinary finished run.
 */
export type ReplyEndState = "none" | "stopped" | "cancelled" | "noReply";

export function resolveRunEndState(run: ApiAgentRun | undefined | null): ReplyEndState {
  if (!run || isRunInProgress(run)) return "none";
  return endState(runHasOutput(run), run.status === "cancelled");
}

/**
 * The same closing line for a finished reply without a run (a chat reply, or an
 * agent row stored without one). Its stop lives in `finishReason`, the only
 * place a chat reply can record it.
 */
export function resolvePlainReplyEndState(
  message: Pick<Message, "content" | "finishReason">,
): ReplyEndState {
  return endState(Boolean(message.content?.trim()), message.finishReason === "stopped");
}

function endState(hasOutput: boolean, stopped: boolean): ReplyEndState {
  if (stopped) return hasOutput ? "stopped" : "cancelled";
  return hasOutput ? "none" : "noReply";
}
