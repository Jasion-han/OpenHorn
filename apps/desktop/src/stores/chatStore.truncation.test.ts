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

test("an ordinary empty Chat failure keeps its reason separate from generated text", () => {
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
  expect(store.getState().messages[0]?.content).toBe("");
  expect(store.getState().messages[0]?.finishReason).toBe("error");
});

for (const content of ["", "```openui-lang\nroot = Card("]) {
  test(`structured failure preserves exact reply and saved identity: ${content.length}`, () => {
    const store = createDesktopChatStore({} as ChatAdapter);
    store.setState({
      messages: [
        {
          id: "temporary",
          conversationId: "conv",
          role: "assistant",
          content,
          mode: "chat",
          createdAt: new Date(),
        },
      ],
      isStreaming: true,
      streamingMessageId: "temporary",
      streamingConversationId: "conv",
    });
    store.getState().applyStreamEvent("temporary", {
      type: "error",
      message: "safe banner",
      messageId: "persisted",
      errorCode: "chat_context_budget_exceeded",
    });
    expect(store.getState().messages[0]?.id).toBe("persisted");
    expect(store.getState().messages[0]?.content).toBe(content);
    expect(store.getState().messages[0]?.finishReason).toBe("context_budget_exceeded");
    expect(store.getState().isStreaming).toBe(false);
  });
}
