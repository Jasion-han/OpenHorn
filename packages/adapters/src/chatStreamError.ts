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
