import { describe, expect, test } from "bun:test";
import { deriveComposerRunState } from "./composerRunState";

describe("deriveComposerRunState", () => {
  test("idle: nothing streaming", () => {
    expect(
      deriveComposerRunState({
        isStreaming: false,
        streamingConversationId: null,
        currentConversationId: "a",
      }),
    ).toEqual({ streamingHere: false, busyElsewhere: false });
  });

  test("streaming in the current conversation", () => {
    expect(
      deriveComposerRunState({
        isStreaming: true,
        streamingConversationId: "a",
        currentConversationId: "a",
      }),
    ).toEqual({ streamingHere: true, busyElsewhere: false });
  });

  test("streaming in another conversation", () => {
    expect(
      deriveComposerRunState({
        isStreaming: true,
        streamingConversationId: "a",
        currentConversationId: "b",
      }),
    ).toEqual({ streamingHere: false, busyElsewhere: true });
  });

  test("streaming with no current conversation counts as busy elsewhere", () => {
    expect(
      deriveComposerRunState({
        isStreaming: true,
        streamingConversationId: null,
        currentConversationId: null,
      }),
    ).toEqual({ streamingHere: false, busyElsewhere: true });
  });
});
