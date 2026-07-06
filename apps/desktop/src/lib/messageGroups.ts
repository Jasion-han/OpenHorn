import type { Message } from "../types/chat";

export type GroupedMessageEntry = {
  msg: Message;
  index: number;
};

export type MessageRoundGroup = {
  key: string;
  user?: GroupedMessageEntry;
  assistant?: GroupedMessageEntry;
};

/**
 * Pack a flat message list into round groups (one user + its immediate
 * assistant reply of the same mode) so the virtualizer can treat a round as a
 * single measurable row. The `key` is derived from message ids, so it stays
 * stable across streaming token updates and post-stream full reloads — this is
 * what `getItemKey` relies on to keep measurements/scroll anchored.
 */
export function groupMessagesByRound(messages: Message[]): MessageRoundGroup[] {
  const groups: MessageRoundGroup[] = [];

  for (let index = 0; index < messages.length; index += 1) {
    const msg = messages[index];
    if (!msg) continue;

    if (msg.role === "user") {
      const next = messages[index + 1];
      if (next?.role === "assistant" && next.mode === msg.mode) {
        groups.push({
          key: `${msg.id}:${next.id}`,
          user: { msg, index },
          assistant: { msg: next, index: index + 1 },
        });
        index += 1;
        continue;
      }

      groups.push({
        key: msg.id,
        user: { msg, index },
      });
      continue;
    }

    groups.push({
      key: msg.id,
      assistant: { msg, index },
    });
  }

  return groups;
}

/**
 * Locate the group index that contains a given message id (matching either the
 * user or the assistant entry). Used to translate the legacy message-id scroll
 * target into a virtualizer `scrollToIndex` call. Returns -1 when not present.
 */
export function findGroupIndexByMessageId(groups: MessageRoundGroup[], messageId: string): number {
  return groups.findIndex(
    (group) => group.user?.msg.id === messageId || group.assistant?.msg.id === messageId,
  );
}
