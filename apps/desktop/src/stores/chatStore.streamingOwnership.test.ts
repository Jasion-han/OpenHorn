import { describe, expect, test } from "bun:test";
import type { ChatAdapter } from "../lib/chatAdapter";
import type { Message } from "../types/chat";
import { createDesktopChatStore } from "./chatStore";

const reply = (id: string, conversationId = "conversation"): Message => ({
  id,
  conversationId,
  role: "assistant",
  content: "partial reply",
  mode: "agent",
  agentRun: {
    status: "running",
    summary: "Working",
    steps: [{ type: "text", content: "partial reply", timestamp: Date.now() }],
  },
  createdAt: new Date(),
});

describe("composer streaming ownership", () => {
  test("background list refresh cannot clear the current turn's loading or error", async () => {
    const store = createDesktopChatStore({
      listConversations: async () => [],
    } as unknown as ChatAdapter);
    store.setState({ isLoading: true, error: "current failure" });
    await store.getState().loadConversations({ background: true });
    expect(store.getState().isLoading).toBe(true);
    expect(store.getState().error).toBe("current failure");
  });

  test("another message's completion or failure cannot release the current turn", () => {
    const store = createDesktopChatStore({} as ChatAdapter);
    store.getState().replaceMessages([reply("running"), reply("background")]);
    store.getState().setStreaming(true, "conversation", "running");
    store.getState().applyStreamEvent("background", { type: "done" });
    store
      .getState()
      .applyStreamEvent("background", { type: "error", message: "background failed" });

    expect(store.getState().isStreaming).toBe(true);
    expect(store.getState().streamingMessageId).toBe("running");
    expect(store.getState().streamingConversationId).toBe("conversation");
    expect(store.getState().error).toBe(null);
    expect(store.getState().findMessageAnywhere("background")?.agentRun?.error).toBe(
      "background failed",
    );

    store.getState().applyStreamEvent("running", { type: "error", message: "current failed" });
    expect(store.getState().isStreaming).toBe(false);
    expect(store.getState().streamingMessageId).toBe(null);
    expect(store.getState().error).toBe("current failed");
    expect(store.getState().findMessageAnywhere("running")?.content).toBe("partial reply");
  });

  test("persisted Chat id replacement transfers ownership before completion", () => {
    const store = createDesktopChatStore({} as ChatAdapter);
    store.getState().replaceMessages([reply("optimistic")]);
    store.getState().setStreaming(true, "conversation", "optimistic");
    store.getState().updateMessage("optimistic", { id: "persisted" });
    expect(store.getState().streamingMessageId).toBe("persisted");
    store.getState().completeStreamingMessage("optimistic");
    expect(store.getState().isStreaming).toBe(true);
    store.getState().completeStreamingMessage("persisted");
    expect(store.getState().isStreaming).toBe(false);
  });

  test("a terminal edited-tail id completes exactly its renamed owner", () => {
    const store = createDesktopChatStore({} as ChatAdapter);
    store.getState().replaceMessages([reply("edited-tail")]);
    store.getState().setStreaming(true, "conversation", "edited-tail");
    store.getState().applyStreamEvent("edited-tail", {
      type: "done",
      messageId: "persisted-tail",
    });
    expect(store.getState().messages[0].id).toBe("persisted-tail");
    expect(store.getState().isStreaming).toBe(false);
    expect(store.getState().streamingMessageId).toBe(null);
  });

  test("Agent reconciliation transfers an owner in a background conversation", () => {
    const store = createDesktopChatStore({} as ChatAdapter);
    store.getState().seedConversationMessages("background", [reply("draft", "background")]);
    store.getState().setStreaming(true, "background", "draft");
    store.getState().reconcileSidecarMessageIds({
      conversationId: "background",
      assistantDraftId: "draft",
      userMessageId: "stored-user",
      assistantMessageId: "stored-assistant",
    });
    expect(store.getState().streamingMessageId).toBe("stored-assistant");
    expect(store.getState().findMessageAnywhere("stored-assistant")?.content).toBe("partial reply");
    store.getState().completeStreamingMessage("stored-assistant");
    expect(store.getState().isStreaming).toBe(false);
    store.getState().setStreaming(true, "background", "another");
    store.getState().reset();
    expect(store.getState().streamingMessageId).toBe(null);
  });
});
