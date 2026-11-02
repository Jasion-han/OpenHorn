import { expect, test } from "bun:test";
import type { ChatAdapter } from "../lib/chatAdapter";
import { createDesktopChatStore } from "./chatStore";

test("an empty truncated reply keeps generated content separate from the error banner", () => {
  const store = createDesktopChatStore({} as ChatAdapter);
  store.setState({
    messages: [
      {
        id: "reply",
        conversationId: "conv",
        role: "assistant",
        content: "",
        mode: "chat",
        finishReason: "length",
        createdAt: new Date(),
      },
    ],
    isStreaming: true,
    streamingMessageId: "reply",
    streamingConversationId: "conv",
  });
  store.getState().failStreamingMessage("reply", "output limit reached");
  expect(store.getState().messages[0]?.content).toBe("");
  expect(store.getState().messages[0]?.finishReason).toBe("length");
  expect(store.getState().error).toBe("output limit reached");
  expect(store.getState().isStreaming).toBe(false);
});

test("an ordinary empty Chat failure still displays its existing fallback", () => {
  const store = createDesktopChatStore({} as ChatAdapter);
  store.setState({
    messages: [
      {
        id: "reply",
        conversationId: "conv",
        role: "assistant",
        content: "",
        mode: "chat",
        createdAt: new Date(),
      },
    ],
  });
  store.getState().failStreamingMessage("reply", "upstream failed");
  expect(store.getState().messages[0]?.content).toBe("upstream failed");
  expect(store.getState().messages[0]?.finishReason).toBe(undefined);
});
