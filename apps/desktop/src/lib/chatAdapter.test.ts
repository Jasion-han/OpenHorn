import { describe, expect, test } from "bun:test";
import { createChatAdapter } from "./chatAdapter";
import type { ServerApi } from "./serverApi";
import type { ApiChannel, ApiConversation, ApiMessage } from "../types/chat";

function createStubServerApi() {
  let streamedBody: unknown;
  let streamedSignal: AbortSignal | undefined;

  const api: ServerApi = {
    conversations: {
      list: async () => ({
        conversations: [
          {
            id: "conv-1",
            userId: "user-1",
            title: "桌面会话",
            channelId: "channel-1",
            modelId: "claude-3-7-sonnet",
            systemPrompt: "be precise",
            contextLength: 8192,
            defaultMode: "agent",
            lastMode: "chat",
            isPinned: true,
            forceWebSearch: false,
            runStatus: "completed",
            createdAt: "2026-03-20T10:00:00.000Z",
            updatedAt: "2026-03-21T10:00:00.000Z",
          } satisfies ApiConversation,
        ],
      }),
      create: async (data) => ({
        conversation: {
          id: "conv-created",
          userId: "user-1",
          title: data.title,
          channelId: data.channelId ?? null,
          modelId: data.modelId ?? null,
          systemPrompt: null,
          contextLength: 4096,
          defaultMode: "agent",
          lastMode: "agent",
          isPinned: false,
          forceWebSearch: true,
          runStatus: null,
          createdAt: "2026-03-22T10:00:00.000Z",
          updatedAt: "2026-03-22T10:00:00.000Z",
        },
      }),
      update: async () => ({ success: true }),
      delete: async () => ({ success: true }),
    },
    messages: {
      list: async () => ({
        messages: [
          {
            id: "msg-1",
            conversationId: "conv-1",
            role: "assistant",
            content: "已完成",
            model: "claude-3-7-sonnet",
            mode: "agent",
            attachments: JSON.stringify(["att-1"]),
            agentRun: JSON.stringify({
              status: "completed",
              summary: "ok",
              steps: [{ type: "tool_start", toolName: "web.search" }],
            }),
            liveMetadata: JSON.stringify({
              status: "live",
              route: "web_search",
              label: "联网搜索",
              sourceType: "web_search",
            }),
            citations: JSON.stringify([
              {
                title: "Doc",
                url: "https://example.com/doc",
              },
            ]),
            attachmentsMeta: [
              {
                id: "att-1",
                fileName: "spec.md",
                fileType: "text/markdown",
                fileSize: 128,
              },
            ],
            createdAt: "2026-03-21T10:00:00.000Z",
          } satisfies ApiMessage,
        ],
      }),
      stream: async (data, options) => {
        streamedBody = data;
        streamedSignal = options?.signal;
        return new Response("ok", { status: 200 });
      },
    },
    channels: {
      list: async () => ({
        channels: [
          {
            id: "channel-1",
            userId: "user-1",
            name: "Anthropic",
            provider: "anthropic",
            baseUrl: "https://api.anthropic.com",
            enabled: true,
            isDefault: true,
            createdAt: "2026-03-20T10:00:00.000Z",
            updatedAt: "2026-03-21T10:00:00.000Z",
            models: [
              {
                id: "model-row-1",
                channelId: "channel-1",
                modelId: "claude-3-7-sonnet",
                displayName: "Claude 3.7 Sonnet",
                enabled: true,
                isDefault: true,
                createdAt: "2026-03-20T10:00:00.000Z",
                updatedAt: "2026-03-21T10:00:00.000Z",
              },
            ],
            defaultModelId: "claude-3-7-sonnet",
            legacyModel: null,
            hasApiKey: true,
          } satisfies ApiChannel,
        ],
      }),
    },
    settings: {
      get: async () => ({
        settings: {
          desktop_theme: "system",
        },
      }),
    },
  };

  return {
    api,
    getStreamedBody: () => streamedBody,
    getStreamedSignal: () => streamedSignal,
  };
}

describe("chatAdapter", () => {
  test("maps conversation list into desktop chat conversations", async () => {
    const { api } = createStubServerApi();
    const adapter = createChatAdapter(api);

    const conversations = await adapter.listConversations();

    expect(conversations).toHaveLength(1);
    expect(conversations[0]).toMatchObject({
      id: "conv-1",
      title: "桌面会话",
      channelId: "channel-1",
      modelId: "claude-3-7-sonnet",
      defaultMode: "agent",
      lastMode: "chat",
      forceWebSearch: false,
    });
    expect(conversations[0]?.createdAt).toBeInstanceOf(Date);
  });

  test("maps message list into desktop messages", async () => {
    const { api } = createStubServerApi();
    const adapter = createChatAdapter(api);

    const messages = await adapter.loadMessages("conv-1");

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      id: "msg-1",
      mode: "agent",
      attachments: ["att-1"],
      liveStatus: "live",
      liveRoute: "web_search",
      liveLabel: "联网搜索",
    });
    expect(messages[0]?.attachmentsMeta?.[0]?.fileName).toBe("spec.md");
    expect(messages[0]?.agentRun?.status).toBe("completed");
    expect(messages[0]?.citations?.[0]?.url).toBe("https://example.com/doc");
  });

  test("sends stream request with the expected shape and supports abort", async () => {
    const { api, getStreamedBody, getStreamedSignal } = createStubServerApi();
    const adapter = createChatAdapter(api);

    const response = await adapter.sendMessage({
      conversationId: "conv-1",
      content: "继续",
      attachments: ["att-1"],
      mode: "agent",
    });

    expect(response.ok).toBe(true);
    expect(getStreamedBody()).toEqual({
      conversationId: "conv-1",
      content: "继续",
      attachments: ["att-1"],
      mode: "agent",
    });
    expect(getStreamedSignal()).toBeDefined();
    expect(getStreamedSignal()?.aborted).toBe(false);

    adapter.abortActiveStream();

    expect(getStreamedSignal()?.aborted).toBe(true);
  });

  test("exposes the desktop chat contract", async () => {
    const { api } = createStubServerApi();
    const adapter = createChatAdapter(api);

    expect(typeof adapter.listChannels).toBe("function");
    expect(typeof adapter.listConversations).toBe("function");
    expect(typeof adapter.createConversation).toBe("function");
    expect(typeof adapter.updateConversation).toBe("function");
    expect(typeof adapter.deleteConversation).toBe("function");
    expect(typeof adapter.loadMessages).toBe("function");
    expect(typeof adapter.sendMessage).toBe("function");
    expect(typeof adapter.abortActiveStream).toBe("function");
    expect(await adapter.getSettings(["desktop_theme"])).toEqual({
      desktop_theme: "system",
    });
  });
});
