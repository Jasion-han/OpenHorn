import { describe, expect, test } from "bun:test";
import { createDesktopChatStore } from "./chatStore";
import type { ChatAdapter } from "../lib/chatAdapter";
import type { Channel, Conversation, Message } from "../types/chat";

function createStubAdapter() {
  let sendInput: unknown;
  let deletedMessageId: string | null = null;
  let regeneratedMessageId: string | null = null;
  let regeneratedPayload: unknown;
  let editedMessageId: string | null = null;
  let editedContent: string | null = null;

  const adapter: ChatAdapter = {
    listChannels: async () =>
      [
        {
          id: "channel-1",
          userId: "user-1",
          name: "Anthropic",
          provider: "anthropic",
          protocol: "anthropic",
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
    autoTitleConversation: async (_conversationId, prompt) => ({
      success: true,
      title: `标题: ${prompt}`,
    }),
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
    deleteMessage: async (messageId) => {
      deletedMessageId = messageId;
    },
    regenerateMessage: async (messageId, data) => {
      regeneratedMessageId = messageId;
      regeneratedPayload = data;
      return new Response("ok", { status: 200 });
    },
    editUserMessage: async (messageId, content) => {
      editedMessageId = messageId;
      editedContent = content;
      return new Response("ok", { status: 200 });
    },
    abortActiveStream: () => {},
    getSettings: async () => ({}),
  };

  return {
    adapter,
    getSendInput: () => sendInput,
    getDeletedMessageId: () => deletedMessageId,
    getRegeneratedMessageId: () => regeneratedMessageId,
    getRegeneratedPayload: () => regeneratedPayload,
    getEditedMessageId: () => editedMessageId,
    getEditedContent: () => editedContent,
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

  test("keeps uploaded attachment metadata on optimistic user message", async () => {
    const { adapter } = createStubAdapter();
    const store = createDesktopChatStore(adapter);

    await store.getState().loadConversations();
    await store.getState().selectConversation("conv-1");

    const result = await store.getState().sendMessage({
      content: "",
      attachments: ["att-1"],
      attachmentsMeta: [
        {
          id: "att-1",
          fileName: "README.md",
          fileType: "text/markdown",
          fileSize: 128,
        },
      ],
    });

    expect(result.userMessageId.startsWith("draft-user-")).toBe(true);
    expect(store.getState().messages[1]).toMatchObject({
      id: result.userMessageId,
      role: "user",
      attachments: ["att-1"],
      attachmentsMeta: [
        {
          id: "att-1",
          fileName: "README.md",
          fileType: "text/markdown",
          fileSize: 128,
        },
      ],
    });
  });

  test("appends stream delta to assistant placeholder", async () => {
    const { adapter } = createStubAdapter();
    const store = createDesktopChatStore(adapter);

    await store.getState().loadConversations();
    await store.getState().selectConversation("conv-1");
    const result = await store.getState().sendMessage({ content: "继续执行" });

    store.getState().applyStreamEvent(result.assistantMessageId, {
      type: "delta",
      content: "第一段",
    });
    store.getState().applyStreamEvent(result.assistantMessageId, {
      type: "delta",
      content: "第二段",
    });

    expect(store.getState().messages[2]).toMatchObject({
      content: "第一段第二段",
      streamTail: "第一段第二段",
      streamPulseKey: 2,
    });
  });

  test("maps live status metadata onto the assistant message", async () => {
    const { adapter } = createStubAdapter();
    const store = createDesktopChatStore(adapter);

    await store.getState().loadConversations();
    await store.getState().selectConversation("conv-1");
    const result = await store.getState().sendMessage({ content: "继续执行" });

    store.getState().applyStreamEvent(result.assistantMessageId, {
      type: "live_status",
      status: "live",
      route: "web_search",
      label: "联网搜索",
    });

    expect(store.getState().messages[2]).toMatchObject({
      liveStatus: "live",
      liveRoute: "web_search",
      liveLabel: "联网搜索",
    });
  });

  test("updates inline agent run metadata and marks stream complete", async () => {
    const { adapter } = createStubAdapter();
    const store = createDesktopChatStore(adapter);

    await store.getState().loadConversations();
    await store.getState().selectConversation("conv-1");
    const result = await store.getState().sendMessage({ content: "继续执行", mode: "agent" });

    store.getState().applyStreamEvent(result.assistantMessageId, {
      type: "agent_event",
      event: {
        type: "tool_start",
        toolName: "web.search",
        toolInput: { q: "OpenHorn" },
      },
    });
    store.getState().applyStreamEvent(result.assistantMessageId, {
      type: "done",
      messageId: "assistant-final-1",
      model: "claude-3-7-sonnet",
      agentRun: {
        status: "completed",
        summary: "完成",
        steps: [
          {
            type: "tool_start",
            toolName: "web.search",
          },
        ],
      },
    });

    expect(store.getState().isStreaming).toBe(false);
    expect(store.getState().messages[2]).toMatchObject({
      id: "assistant-final-1",
      model: "claude-3-7-sonnet",
    });
    expect(store.getState().messages[2]?.agentRun?.status).toBe("completed");
  });

  test("rolls back optimistic draft messages when send fails", async () => {
    const { adapter } = createStubAdapter();
    const store = createDesktopChatStore({
      ...adapter,
      sendMessage: async () => {
        throw new Error("network failed");
      },
    });

    await store.getState().loadConversations();
    await store.getState().selectConversation("conv-1");

    let caught: unknown;
    try {
      await store.getState().sendMessage({ content: "继续执行" });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe("network failed");
    expect(store.getState().isStreaming).toBe(false);
    expect(store.getState().messages).toHaveLength(1);
    expect(store.getState().messages[0]?.id).toBe("msg-1");
  });

  test("toggles composer mode", () => {
    const { adapter } = createStubAdapter();
    const store = createDesktopChatStore(adapter);

    store.getState().setComposerMode("chat");

    expect(store.getState().composerMode).toBe("chat");
  });

  test("stops active streaming via adapter", () => {
    let aborted = false;
    const { adapter } = createStubAdapter();
    const store = createDesktopChatStore({
      ...adapter,
      abortActiveStream: () => {
        aborted = true;
      },
    });

    store.getState().setStreaming(true);
    store.getState().abortStreaming();

    expect(aborted).toBe(true);
    expect(store.getState().isStreaming).toBe(false);
  });

  test("deletes message through adapter and removes it locally", async () => {
    const { adapter, getDeletedMessageId } = createStubAdapter();
    const store = createDesktopChatStore(adapter);

    await store.getState().loadConversations();
    await store.getState().selectConversation("conv-1");
    await store.getState().deleteMessage("msg-1");

    expect(getDeletedMessageId()).toBe("msg-1");
    expect(store.getState().messages).toHaveLength(0);
  });

  test("regenerates message through adapter", async () => {
    const { adapter, getRegeneratedMessageId, getRegeneratedPayload } = createStubAdapter();
    const store = createDesktopChatStore(adapter);

    const response = await store.getState().regenerateMessage("msg-1", {
      userMessageId: "msg-user-1",
      userContent: "继续",
    });

    expect(response.ok).toBe(true);
    expect(getRegeneratedMessageId()).toBe("msg-1");
    expect(getRegeneratedPayload()).toEqual({
      userMessageId: "msg-user-1",
      userContent: "继续",
    });
  });

  test("edits user message through adapter", async () => {
    const { adapter, getEditedMessageId, getEditedContent } = createStubAdapter();
    const store = createDesktopChatStore(adapter);

    const response = await store.getState().editUserMessage("msg-user-1", "重新描述");

    expect(response.ok).toBe(true);
    expect(getEditedMessageId()).toBe("msg-user-1");
    expect(getEditedContent()).toBe("重新描述");
  });

  test("updates conversation fields optimistically", async () => {
    const { adapter } = createStubAdapter();
    const store = createDesktopChatStore(adapter);

    await store.getState().loadConversations();
    await store.getState().updateConversation("conv-1", {
      title: "已重命名",
      isPinned: true,
    });

    expect(store.getState().conversations[0]).toMatchObject({
      id: "conv-1",
      title: "已重命名",
      isPinned: true,
    });
  });

  test("updates local conversation title after auto title succeeds", async () => {
    const { adapter } = createStubAdapter();
    const store = createDesktopChatStore(adapter);

    await store.getState().loadConversations();
    await store.getState().selectConversation("conv-1");

    const result = await store.getState().autoTitleConversation("conv-1", "第一条消息");

    expect(result).toEqual({
      success: true,
      title: "标题: 第一条消息",
    });
    expect(store.getState().conversations[0]?.title).toBe("标题: 第一条消息");
    expect(store.getState().currentConversation?.title).toBe("标题: 第一条消息");
  });
});
