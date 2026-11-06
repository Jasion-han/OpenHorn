/** Coordinates are relative to the chat viewport, never the document/window. */
export type ChatScrollAnchor = {
  conversationId: string;
  messageKey: string;
  roundKey: string;
  viewportOffset: number;
} & (
  | { attachmentIndex: number; linkIndex?: never; pathId?: never }
  | { linkIndex: number; attachmentIndex?: never; pathId?: never }
  | { pathId: string; pathOccurrence?: number; attachmentIndex?: never; linkIndex?: never }
);

export function captureAttachmentScrollAnchor(
  element: HTMLElement,
  attachmentIndex: number,
): Extract<ChatScrollAnchor, { attachmentIndex: number }> | undefined {
  const viewport = element.closest<HTMLElement>("[data-chat-scroll-viewport]");
  const message = element.closest<HTMLElement>("[data-chat-message-key]");
  const round = element.closest<HTMLElement>("[data-chat-round-key]");
  if (!viewport || !message || !round) return;
  const { chatConversationId: conversationId, chatMessageKey: messageKey } = message.dataset;
  const roundKey = round.dataset.chatRoundKey;
  if (!conversationId || !messageKey || !roundKey) return;
  return {
    conversationId,
    messageKey,
    roundKey,
    attachmentIndex,
    viewportOffset: element.getBoundingClientRect().top - viewport.getBoundingClientRect().top,
  };
}

export function captureUserLinkScrollAnchor(
  element: HTMLElement,
  linkIndex: number,
): ChatScrollAnchor | undefined {
  const origin = captureAttachmentScrollAnchor(element, 0);
  if (!origin) return;
  const { attachmentIndex: _attachmentIndex, ...position } = origin;
  return { ...position, linkIndex };
}

export function captureLocalPathScrollAnchor(
  element: HTMLElement,
  pathId: string,
): ChatScrollAnchor | undefined {
  const origin = captureAttachmentScrollAnchor(element, 0);
  if (!origin) return;
  const { attachmentIndex: _attachmentIndex, ...position } = origin;
  const message = element.closest<HTMLElement>("[data-chat-message-key]");
  const occurrences = Array.from(
    message?.querySelectorAll<HTMLElement>("[data-chat-local-path-id]") ?? [],
  ).filter((node) => node.dataset.chatLocalPathId === pathId);
  return { ...position, pathId, pathOccurrence: Math.max(0, occurrences.indexOf(element)) };
}

export function findChatScrollAnchor(
  viewport: HTMLElement,
  anchor: ChatScrollAnchor,
): HTMLElement | null {
  const message = Array.from(
    viewport.querySelectorAll<HTMLElement>("[data-chat-message-key]"),
  ).find(
    (element) =>
      element.dataset.chatMessageKey === anchor.messageKey &&
      element.dataset.chatConversationId === anchor.conversationId,
  );
  if (anchor.pathId !== undefined)
    return (
      Array.from(message?.querySelectorAll<HTMLElement>("[data-chat-local-path-id]") ?? []).filter(
        (element) => element.dataset.chatLocalPathId === anchor.pathId,
      )[anchor.pathOccurrence ?? 0] ?? null
    );
  return (
    message?.querySelector<HTMLElement>(
      anchor.linkIndex !== undefined
        ? `[data-chat-user-link-index="${anchor.linkIndex}"]`
        : `[data-chat-attachment-index="${anchor.attachmentIndex}"]`,
    ) ?? null
  );
}
