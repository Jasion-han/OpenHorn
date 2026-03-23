import { describe, expect, test } from "bun:test";
import { createDesktopChatStore } from "./chatStore";
import type { ChatAdapter } from "../lib/chatAdapter";
import type { Channel, Conversation, Message } from "../types/chat";

function createStubAdapter() {
  let sendInput: unknown;

  const adapter: ChatAdapter = {
    listChannels: async () =>
      [
        {
          id: "channel-1",
          userId: "user-1",
          name: "Anthropic",
          provider: "anthropic",
          enabled: true,
          isDefault: true,
          createdAt: new Date("2026-03-20T10:00:00.000Z"),
          updatedAt: new Date("2026-03-20T10:00:00.000Z"),
          models: [],
          hasApiKey: true,
        },
      ] satisfies Channel[],
    listConversations: async () =>
      [
        {
          id: "conv-1",
          title: "桌面聊天",
          channelId: "channel-1",
          contextLength: 4096,
          defaultMode: "agent",
          lastMode: "agent",
          isPinned: false,
          forceWebSearch: true,
          createdAt: new Date("2026-03-20T10:00:00.000Z"),
          updatedAt: new Date("2026-03-20T10:00:00.000Z"),
        },
      ] satisfies Conversation[],
    createConversation: async (input) => ({
      id: "conv-created",
      title: input.title,
      channelId: input.channelId ?? undefined,
      modelId: input.modelId ?? undefined,
      contextLength: 4096,
      defaultMode: "agent",
      lastMode: "agent",
      isPinned: false,
      forceWebSearch: true,
      createdAt: new Date("2026-03-21T10:00:00.000Z"),
      updatedAt: new Date("2026-03-21T10:00:00.000Z"),
    }),
    updateConversation: async () => {},
    deleteConversation: async () => {},
    loadMessages: async () =>
      [
        {
          id: "msg-1",
          conversationId: "conv-1",
          role: "assistant",
          content: "你好",
          mode: "agent",
          createdAt: new Date("2026-03-20T10:01:00.000Z"),
        },
      ] satisfies Message[],
    sendMessage: async (input) => {
      sendInput = input;
      return new Response("ok", { status: 200 });
    },
    abortActiveStream: () => {},
    getSettings: async () => ({}),
  };

  return {
    adapter,
    getSendInput: () => sendInput,
  };
}

describe("desktop chat store", () => {
  test("loads conversations", async () => {
    const { adapter } = createStubAdapter();
    const store = createDesktopChatStore(adapter);

    await store.getState().loadConversations();

    expect(store.getState().conversations).toHaveLength(1);
    expect(store.getState().conversations[0]).toMatchObject({
      id: "conv-1",
      title: "桌面聊天",
    });
  });

  test("selects conversation and loads messages", async () => {
    const { adapter } = createStubAdapter();
    const store = createDesktopChatStore(adapter);

    await store.getState().loadConversations();
    await store.getState().selectConversation("conv-1");

    expect(store.getState().currentConversation?.id).toBe("conv-1");
    expect(store.getState().messages).toHaveLength(1);
    expect(store.getState().messages[0]?.content).toBe("你好");
  });

  test("adds optimistic assistant placeholder while streaming", async () => {
    const { adapter, getSendInput } = createStubAdapter();
    const store = createDesktopChatStore(adapter);

    await store.getState().loadConversations();
    await store.getState().selectConversation("conv-1");
    const result = await store.getState().sendMessage({ content: "继续执行" });

    expect(store.getState().isStreaming).toBe(true);
    expect(store.getState().messages).toHaveLength(3);
    expect(store.getState().messages[1]).toMatchObject({
      role: "user",
      content: "继续执行",
    });
    expect(store.getState().messages[2]).toMatchObject({
      id: result.assistantMessageId,
      role: "assistant",
      content: "",
    });
    expect(getSendInput()).toEqual({
      conversationId: "conv-1",
      content: "继续执行",
      attachments: undefined,
      mode: "agent",
    });
  });

  test("toggles composer mode", () => {
    const { adapter } = createStubAdapter();
    const store = createDesktopChatStore(adapter);

    store.getState().setComposerMode("chat");

    expect(store.getState().composerMode).toBe("chat");
  });
});
