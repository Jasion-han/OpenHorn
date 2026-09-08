// Shell-style ↑/↓ recall of previously sent user messages in the composer.
// Pure logic only; DesktopChatArea owns the textarea and the nav state ref.

export interface HistoryNavState {
  // null = not navigating. Otherwise an index into `history`, where
  // `history.length - 1` is the newest entry.
  index: number | null;
  // Text the user had typed before entering history; restored when walking
  // past the newest entry.
  draft: string;
}

export function resetHistoryNav(): HistoryNavState {
  return { index: null, draft: "" };
}

// User-role messages in send order (oldest → newest), trimmed, blanks dropped,
// consecutive duplicates collapsed so repeated sends don't need extra presses.
export function buildComposerHistory(messages: Array<{ role: string; content: string }>): string[] {
  const history: string[] = [];
  for (const message of messages) {
    if (message.role !== "user") continue;
    const text = (message.content || "").trim();
    if (!text) continue;
    if (history.length > 0 && history[history.length - 1] === text) continue;
    history.push(text);
  }
  return history;
}

// `text: null` means "no change, let the browser handle the key".
export function navigateHistory(
  state: HistoryNavState,
  history: string[],
  direction: "up" | "down",
  currentText: string,
): { state: HistoryNavState; text: string | null } {
  if (direction === "up") {
    if (state.index === null) {
      if (history.length === 0) return { state, text: null };
      const index = history.length - 1;
      return { state: { index, draft: currentText }, text: history[index] };
    }
    if (state.index <= 0) return { state, text: null };
    const index = state.index - 1;
    return { state: { ...state, index }, text: history[index] };
  }

  if (state.index === null) return { state, text: null };
  if (state.index >= history.length - 1) {
    return { state: { index: null, draft: "" }, text: state.draft };
  }
  const index = state.index + 1;
  return { state: { ...state, index }, text: history[index] };
}

export function caretOnFirstLine(value: string, selectionStart: number): boolean {
  return !value.slice(0, selectionStart).includes("\n");
}

export function caretOnLastLine(value: string, selectionEnd: number): boolean {
  return !value.slice(selectionEnd).includes("\n");
}
