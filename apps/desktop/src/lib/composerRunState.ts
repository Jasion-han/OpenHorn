/**
 * Splits the store's global streaming flag into "this conversation is the one
 * running" vs "some other conversation is running". The sidecar executes a
 * single turn at a time, so the composer must only offer Stop for the turn
 * that belongs to the conversation on screen, and must refuse to send from
 * anywhere else while that turn is in flight.
 */
export function deriveComposerRunState(input: {
  isStreaming: boolean;
  streamingConversationId: string | null;
  currentConversationId: string | null;
}): { streamingHere: boolean; busyElsewhere: boolean } {
  const streamingHere =
    input.isStreaming &&
    input.currentConversationId !== null &&
    input.streamingConversationId === input.currentConversationId;
  const busyElsewhere = input.isStreaming && !streamingHere;
  return { streamingHere, busyElsewhere };
}
