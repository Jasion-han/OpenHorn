import type { Message } from "../types/chat";

type CleanupMessage = Pick<Message, "id" | "role" | "content" | "agentRun">;

/** Optimistic ids that never existed server-side. */
function isLocalOnlyId(id: string): boolean {
  return id.startsWith("temp-") || id.startsWith("draft-");
}

/**
 * Whether an assistant message carries anything worth keeping: reply text, a
 * run timeline (a run that only used tools has steps but no text), or a
 * recorded failure. A partial reply is still a reply.
 */
export function messageHasOutput(message: Pick<Message, "content" | "agentRun">): boolean {
  if (message.content?.trim()) return true;
  if (message.agentRun?.error) return true;
  return (message.agentRun?.steps?.length ?? 0) > 0;
}

/**
 * The server rows to delete after the user stopped a run: only the stopped
 * run's own assistant message, and only when it holds nothing at all — never
 * any other row of the conversation, however empty it is.
 *
 * `stoppedAssistantIds` are the ids the stopped run was streaming into, as the
 * client knew them when Stop was pressed (`before` is the message list at that
 * moment). They may be optimistic (`temp-…`) ids whose server row got a
 * different id — e.g. an edit that created the reply server-side and was
 * aborted before the `done` event carried the real id. Such a run is located
 * through its round instead: the reply directly after the round's user message
 * in the reloaded list (`after`).
 *
 * The local copy is consulted too: if the run had already produced output on
 * screen, the message is kept even when the server row is still empty (its
 * completion may yet be written).
 */
export function selectStoppedRunOrphans(input: {
  stoppedAssistantIds: ReadonlyArray<string | null | undefined>;
  before: ReadonlyArray<CleanupMessage>;
  after: ReadonlyArray<CleanupMessage>;
}): string[] {
  const { before, after } = input;
  const orphans = new Set<string>();

  for (const stoppedId of new Set(input.stoppedAssistantIds)) {
    if (!stoppedId) continue;
    const localIndex = before.findIndex((message) => message.id === stoppedId);
    const local = localIndex >= 0 ? before[localIndex] : undefined;
    if (local && (local.role !== "assistant" || messageHasOutput(local))) continue;

    let target = after.find((message) => message.id === stoppedId);
    if (!target && localIndex > 0) {
      const roundUser = before[localIndex - 1];
      if (roundUser?.role === "user" && !isLocalOnlyId(roundUser.id)) {
        const userIndex = after.findIndex((message) => message.id === roundUser.id);
        const reply = userIndex >= 0 ? after[userIndex + 1] : undefined;
        if (reply?.role === "assistant") target = reply;
      }
    }

    if (!target || target.role !== "assistant" || isLocalOnlyId(target.id)) continue;
    if (messageHasOutput(target)) continue;
    orphans.add(target.id);
  }

  return [...orphans];
}
