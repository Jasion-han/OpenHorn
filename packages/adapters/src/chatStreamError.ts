import type { ChatUsage } from "./adapters";

/** A provider ended the answer at its output limit, after any text was yielded. */
export class ChatStreamTruncatedError extends Error {
  readonly code = "response_truncated";

  constructor(
    readonly finishReason: string,
    readonly usage?: ChatUsage,
  ) {
    super("Response reached the output length limit");
    this.name = "ChatStreamTruncatedError";
  }
}

/** Keep successful generator results compatible; never mistake Stop for length. */
export function finishChatStream(
  finishReason: string | null | undefined,
  usage: ChatUsage | undefined,
  signal?: AbortSignal,
): ChatUsage | undefined {
  if (
    !signal?.aborted &&
    (finishReason === "length" || finishReason === "max_tokens" || finishReason === "MAX_TOKENS")
  ) {
    throw new ChatStreamTruncatedError(finishReason, usage);
  }
  return usage;
}

/** A late safety verdict retracts all text already yielded for this turn. */
export class ChatResponseRefusedError extends Error {
  readonly code = "response_refused";
  constructor(readonly usage?: ChatUsage) {
    super("Response refused by provider");
    this.name = "ChatResponseRefusedError";
  }
}

export function finishOpenAIChatStream(
  finishReason: string | undefined,
  usage: ChatUsage | undefined,
  signal?: AbortSignal,
) {
  if (!signal?.aborted && finishReason === "content_filter")
    throw new ChatResponseRefusedError(usage);
  return finishChatStream(finishReason, usage, signal);
}
