// App-side safety estimates, not tokenizer output or a model's context window.
export const CHAT_MAX_CONTEXT_MESSAGES = 200;
export const CHAT_MAX_CONTEXT_TOKENS = 32_000;
const MESSAGE_OVERHEAD_TOKENS = 10;
const IMAGE_ESTIMATE_TOKENS = 1_024;

type ContextMessage = {
  role: "system" | "user" | "assistant";
  content: unknown;
  providerState?: unknown;
};
type OmissionMessage = { role: "system"; content: string };

/** Conservative text estimate; CJK/emoji must not use the ASCII chars ratio. */
export function estimateContextTextTokens(text: string): number {
  if (!/[^\p{ASCII}]/u.test(text)) return Math.ceil(text.length / 3.5);
  let ascii = 0;
  let other = 0;
  for (const character of text) {
    if (character.charCodeAt(0) < 128) ascii++;
    else other += character.length === 2 ? 4 : 2;
  }
  return Math.ceil(ascii / 3.5) + other;
}

export class ChatContextBudgetError extends Error {
  readonly code = "chat_context_budget_exceeded";

  constructor() {
    super(
      "The current request and system instructions exceed the app's estimated context budget. Shorten the request, attachments, or system instructions and try again.",
    );
    this.name = "ChatContextBudgetError";
  }
}

export function estimateContextMessageTokens(message: ContextMessage): number {
  const estimateText = estimateContextTextTokens;
  let tokens = MESSAGE_OVERHEAD_TOKENS;
  // A provider's opaque webpage signatures are replayed with the assistant
  // message. Include their serialized size before choosing whole old turns.
  if (message.providerState) tokens += estimateText(JSON.stringify(message.providerState));
  if (typeof message.content === "string") return tokens + estimateText(message.content);
  if (!Array.isArray(message.content)) return tokens;
  for (const part of message.content) {
    if (typeof part !== "object" || part === null) continue;
    if (part.type === "text" && typeof part.text === "string") tokens += estimateText(part.text);
    if (part.type === "image") tokens += IMAGE_ESTIMATE_TOKENS;
  }
  return tokens;
}

/**
 * Reserve the complete current user turn and all actual system instructions
 * before selecting older user turns. A user turn and its following answers are
 * atomic: do not keep an answer after dropping its question. These are Chat
 * messages only; tool-call transcripts require their own pairing-aware policy.
 */
export function boundChatContext<T extends ContextMessage>(
  messages: readonly T[],
  limits: { maxTokens?: number; maxMessages?: number; omittedMessages?: number } = {},
): Array<T | OmissionMessage> {
  const maxTokens = limits.maxTokens ?? CHAT_MAX_CONTEXT_TOKENS;
  const maxMessages = limits.maxMessages ?? CHAT_MAX_CONTEXT_MESSAGES;
  const system = messages.filter((message) => message.role === "system");
  const turns = messages.filter((message) => message.role !== "system");
  let currentIndex = turns.length - 1;
  while (currentIndex >= 0 && turns[currentIndex]?.role !== "user") currentIndex--;
  if (currentIndex < 0) throw new Error("A current user request is required for Chat");

  const current = turns.slice(currentIndex);
  let tokenCount = [...system, ...current].reduce(
    (sum, message) => sum + estimateContextMessageTokens(message),
    0,
  );
  let messageCount = system.length + current.length;
  if (tokenCount > maxTokens || messageCount > maxMessages) throw new ChatContextBudgetError();

  const history = turns.slice(0, currentIndex);
  if (
    !limits.omittedMessages &&
    (history.length === 0 || history[0]?.role === "user") &&
    messageCount + history.length <= maxMessages &&
    tokenCount + history.reduce((sum, message) => sum + estimateContextMessageTokens(message), 0) <=
      maxTokens
  ) {
    return [...system, ...history, ...current];
  }
  const groups: T[][] = [];
  for (const message of history) {
    if (message.role === "user") groups.push([message]);
    else groups.at(-1)?.push(message);
  }

  let firstKeptGroup = groups.length;
  let omitted = history.length + (limits.omittedMessages ?? 0);
  const notice = (count: number): OmissionMessage => ({
    role: "system",
    content: `[${count} earlier messages omitted]`,
  });
  for (let i = groups.length - 1; i >= 0; i--) {
    const group = groups[i];
    if (!group) continue;
    const groupTokens = group.reduce(
      (sum, message) => sum + estimateContextMessageTokens(message),
      0,
    );
    const remaining = omitted - group.length;
    const noticeTokens = remaining > 0 ? estimateContextMessageTokens(notice(remaining)) : 0;
    if (
      tokenCount + groupTokens + noticeTokens > maxTokens ||
      messageCount + group.length + (remaining > 0 ? 1 : 0) > maxMessages
    ) {
      break;
    }
    firstKeptGroup = i;
    tokenCount += groupTokens;
    messageCount += group.length;
    omitted = remaining;
  }
  // Flatten once: repeated unshift becomes quadratic on million-token histories.
  const kept = groups.slice(firstKeptGroup).flat();
  if (omitted > 0) {
    const marker = notice(omitted);
    if (
      tokenCount + estimateContextMessageTokens(marker) > maxTokens ||
      messageCount + 1 > maxMessages
    ) {
      throw new ChatContextBudgetError();
    }
    return [...system, marker, ...kept, ...current];
  }
  return [...system, ...kept, ...current];
}
