import { describe, expect, test } from "bun:test";
import { createChatAdapter } from "./chatAdapter";
import type { ServerApi } from "./serverApi";
import type { ApiAgentTaskDetail, ApiChannel, ApiConversation, ApiMessage } from "../types/chat";

function createStubServerApi() {
  let streamedBody: unknown;
  let streamedSignal: AbortSignal | undefined;
  let deletedMessageId: string | null = null;
  let regeneratedMessageId: string | null = null;
  let regeneratedPayload: unknown;
  let editedMessageId: string | null = null;
  let editedContent: string | null = null;
  const emptyTaskDetail: ApiAgentTaskDetail = {
    task: {
      id: "task-1",
      userId: "user-1",
      conversationId: "conv-1",
      channelId: "channel-1",
      modelId: "claude-3-7-sonnet",
      title: "Agent task",
      goal: "Do work",
      attachments: [],
      complexity: "standard",
      uxMode: "full",
      requiresPlanApproval: false,
      autoStart: false,
      status: "draft",
      insight: null,
      createdAt: "2026-03-22T10:00:00.000Z",
      updatedAt: "2026-03-22T10:00:00.000Z",
    },
    runs: [],
    planSteps: [],
    approvals: [],
    artifacts: [],
    events: [],
  };

  const api: ServerApi = {
    auth: {
      login: async () => ({
        user: {
          id: "user-1",
          email: "han@example.com",
          username: "han",
        },
      }),
      register: async () => ({
        user: {
          id: "user-1",
          email: "han@example.com",
          username: "han",
        },
      }),
      logout: async () => ({ success: true }),
      me: async () => ({
        user: {
          id: "user-1",
          email: "han@example.com",
          username: "han",
        },
      }),
    },
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
      autoTitle: async (_id, prompt) => ({
        success: true,
        title: `标题: ${prompt}`,
      }),
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
      delete: async (id) => {
        deletedMessageId = id;
        return { success: true };
      },
      regenerate: async (id, data) => {
        regeneratedMessageId = id;
        regeneratedPayload = data;
        return new Response("ok", { status: 200 });
      },
      edit: async (id, content) => {
        editedMessageId = id;
        editedContent = content;
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
            protocol: "anthropic",
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
      get: async () => ({
        channel: {
          id: "channel-1",
          userId: "user-1",
          name: "Anthropic",
          provider: "anthropic",
          protocol: "anthropic",
          baseUrl: "https://api.anthropic.com",
          enabled: true,
          isDefault: true,
          createdAt: "2026-03-20T10:00:00.000Z",
          updatedAt: "2026-03-21T10:00:00.000Z",
          models: [],
          defaultModelId: "claude-3-7-sonnet",
          legacyModel: null,
          hasApiKey: true,
        } satisfies ApiChannel,
      }),
      create: async () => ({
        channel: {
          id: "channel-created",
          userId: "user-1",
          name: "Created",
          provider: "openai",
          protocol: "openai",
          baseUrl: "https://api.openai.com/v1",
          enabled: true,
          isDefault: false,
          createdAt: "2026-03-20T10:00:00.000Z",
          updatedAt: "2026-03-21T10:00:00.000Z",
          models: [],
          defaultModelId: null,
          legacyModel: null,
          hasApiKey: true,
        } satisfies ApiChannel,
      }),
      update: async () => ({
        channel: {
          id: "channel-1",
          userId: "user-1",
          name: "Anthropic",
          provider: "anthropic",
          protocol: "anthropic",
          baseUrl: "https://api.anthropic.com",
          enabled: true,
          isDefault: true,
          createdAt: "2026-03-20T10:00:00.000Z",
          updatedAt: "2026-03-21T10:00:00.000Z",
          models: [],
          defaultModelId: "claude-3-7-sonnet",
          legacyModel: null,
          hasApiKey: true,
        } satisfies ApiChannel,
      }),
      delete: async () => ({ success: true }),
      test: async () => ({ success: true }),
      fetchModels: async () => ({ success: true, models: [] }),
      listModels: async () => ({ models: [] }),
      updateModels: async () => ({ models: [] }),
      setDefault: async () => ({ success: true }),
      setDefaultModel: async () => ({ success: true }),
      agentCheck: async () => ({ success: true }),
      getCredentials: async () => ({
        credentials: {
          apiKey: "sk-test",
          baseUrl: null,
          modelId: "claude-3-5-sonnet",
          protocol: "anthropic" as const,
        },
      }),
    },
    settings: {
      get: async () => ({
        settings: {
          desktop_theme: "system",
        },
      }),
      set: async () => ({ success: true }),
    },
    mcp: {
      listServers: async () => ({ servers: [] }),
      createServer: async () => ({ server: {} }),
      updateServer: async () => ({ success: true }),
      deleteServer: async () => ({ success: true }),
      testServer: async () => ({ success: true }),
    },
    agentTasks: {
      list: async () => ({ tasks: [] }),
      create: async () => ({
        task: emptyTaskDetail.task,
      }),
      get: async () => emptyTaskDetail,
      plan: async () => emptyTaskDetail,
      execute: async () => new Response("ok", { status: 200 }),
      retry: async () => new Response("ok", { status: 200 }),
      continue: async () => new Response("ok", { status: 200 }),
      cancel: async () => emptyTaskDetail,
      respondApproval: async () => emptyTaskDetail,
    },
  };

  return {
    api,
    getStreamedBody: () => streamedBody,
    getStreamedSignal: () => streamedSignal,
    getDeletedMessageId: () => deletedMessageId,
    getRegeneratedMessageId: () => regeneratedMessageId,
    getRegeneratedPayload: () => regeneratedPayload,
    getEditedMessageId: () => editedMessageId,
    getEditedContent: () => editedContent,
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

  test("deletes and regenerates messages through the desktop adapter", async () => {
    const {
      api,
      getDeletedMessageId,
      getRegeneratedMessageId,
      getRegeneratedPayload,
    } = createStubServerApi();
    const adapter = createChatAdapter(api);

    await adapter.deleteMessage("msg-1");
    const response = await adapter.regenerateMessage("msg-1", {
      userMessageId: "msg-user-1",
      userContent: "继续",
    });

    expect(getDeletedMessageId()).toBe("msg-1");
    expect(response.ok).toBe(true);
    expect(getRegeneratedMessageId()).toBe("msg-1");
    expect(getRegeneratedPayload()).toEqual({
      userMessageId: "msg-user-1",
      userContent: "继续",
    });
  });

  test("edits user messages through the desktop adapter", async () => {
    const { api, getEditedMessageId, getEditedContent } = createStubServerApi();
    const adapter = createChatAdapter(api);

    const response = await adapter.editUserMessage("msg-user-1", "新的问题");

    expect(response.ok).toBe(true);
    expect(getEditedMessageId()).toBe("msg-user-1");
    expect(getEditedContent()).toBe("新的问题");
  });

  test("auto titles conversations through the desktop adapter", async () => {
    const { api } = createStubServerApi();
    const adapter = createChatAdapter(api);

    const result = await adapter.autoTitleConversation("conv-1", "第一条消息");

    expect(result).toEqual({
      success: true,
      title: "标题: 第一条消息",
    });
  });

  test("exposes the desktop chat contract", async () => {
    const { api } = createStubServerApi();
    const adapter = createChatAdapter(api);

    expect(typeof adapter.listChannels).toBe("function");
    expect(typeof adapter.listConversations).toBe("function");
    expect(typeof adapter.createConversation).toBe("function");
    expect(typeof adapter.updateConversation).toBe("function");
    expect(typeof adapter.deleteConversation).toBe("function");
    expect(typeof adapter.autoTitleConversation).toBe("function");
    expect(typeof adapter.loadMessages).toBe("function");
    expect(typeof adapter.sendMessage).toBe("function");
    expect(typeof adapter.deleteMessage).toBe("function");
    expect(typeof adapter.regenerateMessage).toBe("function");
    expect(typeof adapter.editUserMessage).toBe("function");
    expect(typeof adapter.abortActiveStream).toBe("function");
    expect(await adapter.getSettings(["desktop_theme"])).toEqual({
      desktop_theme: "system",
    });
  });
});
