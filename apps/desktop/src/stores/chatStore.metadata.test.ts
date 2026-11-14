import { expect, test } from "bun:test";
import type { ChatAdapter } from "../lib/chatAdapter";
import { createDesktopChatStore } from "./chatStore";

test("native refusal clears streamed text and citations while preserving structured process metadata", () => {
  const store = createDesktopChatStore({} as ChatAdapter);
  store.setState({
    messages: [
      {
        id: "native-reply",
        conversationId: "native-metadata-conversation",
        role: "assistant",
        mode: "chat",
        content: "partial answer",
        citations: [{ title: "Source", url: "https://example.com/" }],
        createdAt: new Date(),
      },
    ],
  });
  const metadata = {
    refused: true,
    citations: [],
    steps: [{ id: "search", action: "search", status: "completed" }],
  };
  store.getState().applyStreamEvent("native-reply", { type: "chat_metadata", metadata });
  expect(store.getState().messages[0].content).toBe("");
  expect(store.getState().messages[0].citations).toEqual([]);
  expect(store.getState().messages[0].finishReason).toBe("refused");
  expect(store.getState().messages[0].nativeMetadata?.steps).toEqual(metadata.steps);
});
