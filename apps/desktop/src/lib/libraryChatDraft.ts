import {
  LIBRARY_LIMITS,
  libraryQuestionPayload,
  readLibraryChatQuestion,
  utf8Bytes,
} from "shared/library";
import type { LibrarySource } from "shared/types";

export { readLibraryChatQuestion };

/** The stored and model-facing format is shared with earlier Library chats. */
export function serializeLibraryChatQuestion(question: string, sources: LibrarySource[]) {
  if (
    !sources.length ||
    sources.length > LIBRARY_LIMITS.sources ||
    question.length > LIBRARY_LIMITS.questionChars
  )
    return null;
  const text = libraryQuestionPayload(question, sources);
  return utf8Bytes(text) <= LIBRARY_LIMITS.sourceBytes ? text : null;
}

type LibraryChatHistory = ReadonlyArray<{ conversationId: string; role: string; content: string }>;

export function latestLibraryChatSources(
  messages: LibraryChatHistory,
  conversationId: string,
): LibrarySource[] | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.conversationId !== conversationId || message.role !== "user") continue;
    const question = readLibraryChatQuestion(message.content);
    if (question) return question.sources;
  }
}

export function librarySourceKey(source: LibrarySource) {
  return JSON.stringify([source.documentId, source.chunkIndex, source.text, source.location]);
}

/** Keep an earlier full snapshot selectable after a narrower follow-up. */
export function libraryChatSourceOptions(
  messages: LibraryChatHistory,
  conversationId: string,
  selected: LibrarySource[],
) {
  const required = selected.map(librarySourceKey);
  let options = selected;
  for (const message of messages) {
    if (message.conversationId !== conversationId || message.role !== "user") continue;
    const earlier = readLibraryChatQuestion(message.content)?.sources;
    if (!earlier || earlier.length <= options.length) continue;
    const keys = new Set(earlier.map(librarySourceKey));
    if (required.every((key) => keys.has(key))) options = earlier;
  }
  return options;
}

export function libraryChatDraftSources(
  messages: LibraryChatHistory,
  conversationId: string,
  draft: { librarySources?: LibrarySource[]; librarySourceSelection?: string[] },
) {
  const previous = latestLibraryChatSources(messages, conversationId);
  const defaults = draft.librarySources ?? previous;
  if (!defaults) return {};
  const libraryOptions = previous
    ? libraryChatSourceOptions(messages, conversationId, defaults)
    : defaults;
  const selection = draft.librarySourceSelection;
  const librarySources = selection
    ? libraryOptions.filter((source) => selection.includes(librarySourceKey(source)))
    : defaults;
  return { librarySources, libraryOptions, canSelectSources: Boolean(previous || selection) };
}

export function appendLibraryChatDraftSource(
  messages: LibraryChatHistory,
  conversationId: string,
  draft: { text: string; librarySources?: LibrarySource[]; librarySourceSelection?: string[] },
  added: LibrarySource,
) {
  const { librarySources = [], libraryOptions = [] } = libraryChatDraftSources(
    messages,
    conversationId,
    draft,
  );
  const sameChunk = (source: LibrarySource) =>
    source.documentId === added.documentId && source.chunkIndex === added.chunkIndex;
  const selectedKeys = new Set(
    librarySources.filter((source) => !sameChunk(source)).map(librarySourceKey),
  );
  selectedKeys.add(librarySourceKey(added));
  const options = libraryOptions.some(sameChunk)
    ? libraryOptions.map((source) => (sameChunk(source) ? added : source))
    : [...libraryOptions, added];
  const selected = options.filter((source) => selectedKeys.has(librarySourceKey(source)));
  if (!serializeLibraryChatQuestion(draft.text.trim(), selected)) return null;
  return { librarySources: options, librarySourceSelection: selected.map(librarySourceKey) };
}
