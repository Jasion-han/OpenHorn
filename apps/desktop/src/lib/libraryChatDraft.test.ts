import { expect, test } from "bun:test";
import { libraryQuestionPayload } from "shared/library";
import {
  appendLibraryChatDraftSource,
  latestLibraryChatSources,
  libraryChatDraftSources,
  libraryChatSourceOptions,
  librarySourceKey,
} from "./libraryChatDraft";

const later = { documentId: "quote", fileName: "quote.md", chunkIndex: 1, text: "36 coins" };
const earlier = { documentId: "quote", fileName: "quote.md", chunkIndex: 0, text: "480 coins" };
const other = { documentId: "other", fileName: "other.md", chunkIndex: 0, text: "private" };

test("a follow-up uses the latest sourced question in its own conversation", () => {
  const messages = [
    { conversationId: "main", role: "user", content: libraryQuestionPayload("First", [earlier]) },
    { conversationId: "main", role: "user", content: libraryQuestionPayload("Second", [later]) },
    {
      conversationId: "main",
      role: "assistant",
      content: libraryQuestionPayload("Output", [other]),
    },
    { conversationId: "main", role: "user", content: "Legacy follow-up" },
    { conversationId: "other", role: "user", content: libraryQuestionPayload("Private", [other]) },
  ];
  expect(latestLibraryChatSources(messages, "main")).toEqual([later]);
  expect(latestLibraryChatSources(messages, "other")).toEqual([other]);
  expect(latestLibraryChatSources(messages, "empty")).toBe(undefined);
});

test("a narrowed follow-up can select from the matching earlier snapshot", () => {
  const messages = [
    {
      conversationId: "main",
      role: "user",
      content: libraryQuestionPayload("Unrelated", [other, earlier]),
    },
    {
      conversationId: "main",
      role: "user",
      content: libraryQuestionPayload("Both", [earlier, later]),
    },
    { conversationId: "main", role: "user", content: libraryQuestionPayload("Focused", [later]) },
  ];
  expect(libraryChatSourceOptions(messages, "main", [later])).toEqual([earlier, later]);
  expect(libraryChatSourceOptions(messages, "empty", [later])).toEqual([later]);
});

test("appending a source preserves narrowed selections and replaces an updated copy of the same chunk", () => {
  const history = [
    {
      conversationId: "main",
      role: "user",
      content: libraryQuestionPayload("Both", [earlier, later]),
    },
  ];
  const draft = { text: "Keep my question", librarySourceSelection: [librarySourceKey(later)] };
  const appended = appendLibraryChatDraftSource(history, "main", draft, other);
  expect(appended?.librarySources).toEqual([earlier, later, other]);
  expect(appended?.librarySourceSelection).toEqual([
    librarySourceKey(later),
    librarySourceKey(other),
  ]);
  const replacement = { ...later, text: "Updated freight" };
  const updated = appendLibraryChatDraftSource(
    history,
    "main",
    { ...draft, ...appended },
    replacement,
  );
  expect(updated?.librarySources).toEqual([earlier, replacement, other]);
  expect(libraryChatDraftSources(history, "main", updated ?? {}).librarySources).toEqual([
    replacement,
    other,
  ]);
  expect(
    appendLibraryChatDraftSource(history, "main", draft, { ...other, text: "x".repeat(25 * 1024) }),
  ).toBe(null);
});
