/** Active asynchronous Chat edits/retries in this server process only. */
export type ChatMutationOwner = {
  readonly order: number;
  readonly userId: string;
  readonly abortController: AbortController;
  readonly keys: Set<string>;
  valid: boolean;
  conversationId?: string;
  userMessageId?: string;
  assistantMessageId?: string;
  reservedAssistantId?: string;
};

const owners = new Map<string, ChatMutationOwner>();
let order = 0;
const keyFor = (userId: string, messageId: string) => JSON.stringify([userId, messageId]);

function invalidate(owner: ChatMutationOwner) {
  owner.valid = false;
  owner.abortController.abort("chat_mutation_replaced");
}

export function ownsChatMutation(owner: ChatMutationOwner): boolean {
  return owner.valid && [...owner.keys].every((key) => owners.get(key) === owner);
}

/** A delayed earlier preparation cannot claim an alias owned by a newer call. */
export function bindChatMutation(owner: ChatMutationOwner, ...messageIds: string[]): boolean {
  if (!owner.valid) return false;
  const keys = new Set([...owner.keys, ...messageIds.map((id) => keyFor(owner.userId, id))]);
  // Existing aliases describe the same active user/assistant pair. Claim them
  // together so changing between Edit and Retry has the same cancellation owner.
  for (const key of keys) {
    const previous = owners.get(key);
    if (!previous || previous === owner) continue;
    if (previous.order > owner.order) {
      invalidate(owner);
      return false;
    }
    for (const alias of previous.keys) keys.add(alias);
    owner.conversationId ??= previous.conversationId;
    owner.userMessageId ??= previous.userMessageId;
    owner.assistantMessageId ??= previous.assistantMessageId;
    owner.reservedAssistantId ??= previous.reservedAssistantId;
  }
  for (const key of keys) {
    const previous = owners.get(key);
    if (previous && previous !== owner) invalidate(previous);
    owners.set(key, owner);
    owner.keys.add(key);
  }
  return true;
}

export function beginChatMutation(userId: string, messageId: string): ChatMutationOwner {
  const owner: ChatMutationOwner = {
    order: ++order,
    userId,
    abortController: new AbortController(),
    keys: new Set(),
    valid: true,
  };
  bindChatMutation(owner, messageId);
  return owner;
}

export function releaseChatMutation(owner: ChatMutationOwner) {
  owner.valid = false;
  for (const key of owner.keys) {
    if (owners.get(key) === owner) owners.delete(key);
  }
}

export function invalidateChatMutation(userId: string, messageId: string) {
  const owner = owners.get(keyFor(userId, messageId));
  if (!owner || !ownsChatMutation(owner)) return null;
  invalidate(owner);
  return owner;
}

/** Invoke only after conversation deletion commits, including project deletes. */
export function invalidateConversationChatMutations(
  userId: string,
  conversationId: string,
  messageIds: readonly string[],
) {
  const deletedKeys = new Set(messageIds.map((id) => keyFor(userId, id)));
  for (const owner of new Set(owners.values())) {
    if (
      owner.userId === userId &&
      (owner.conversationId === conversationId ||
        [...owner.keys].some((key) => deletedKeys.has(key)))
    )
      invalidate(owner);
  }
}
