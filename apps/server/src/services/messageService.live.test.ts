import { expect, mock, test } from "bun:test";

function parseSsePayloads(raw: string) {
  return raw
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice("data: ".length)));
}

async function readStreamText(stream: ReadableStream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let output = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    output += decoder.decode(value, { stream: true });
  }

  output += decoder.decode();
  return output;
}

test("stream chat emits live status metadata before assistant deltas", async () => {
  const conversationTable = {
    id: "conversation_id",
    userId: "conversation_user_id",
    channelId: "conversation_channel_id",
    modelId: "conversation_model_id",
    updatedAt: "conversation_updated_at",
    lastMode: "conversation_last_mode",
    runStatus: "conversation_run_status",
  };
  const messageTable = {
    id: "message_id",
    conversationId: "message_conversation_id",
    createdAt: "message_created_at",
  };
  const attachmentTable = {
    id: "attachment_id",
    messageId: "attachment_message_id",
    fileName: "attachment_file_name",
    fileType: "attachment_file_type",
    fileSize: "attachment_file_size",
  };

  const chatStreamCalls: Array<{
    model: string;
    messages: Array<{ role: string; content: unknown }>;
  }> = [];
  const insertedRows: Array<Record<string, unknown>> = [];
  const updatedRows: Array<Record<string, unknown>> = [];

  mock.module("db", () => ({
    conversations: conversationTable,
    messages: messageTable,
    attachments: attachmentTable,
  }));

  mock.module("../db", () => ({
    db: {
      select: () => ({
        from: (table: unknown) => {
          if (table === conversationTable) {
            return {
              where: () => ({
                limit: async () => [
                  {
                    id: "conv-1",
                    userId: "user-1",
                    channelId: "channel-1",
                    modelId: "claude-3-7-sonnet",
                    systemPrompt: "Base system prompt",
                  },
                ],
              }),
            };
          }

          if (table === messageTable) {
            return {
              where: () => ({
                orderBy: async () => [
                  {
                    id: "user-msg-1",
                    role: "user",
                    content: "今天周几",
                    attachments: null,
                  },
                ],
              }),
            };
          }

          throw new Error("Unexpected table in select");
        },
      }),
      insert: () => ({
        values: async (value: unknown) => {
          if (value && typeof value === "object") {
            insertedRows.push(value as Record<string, unknown>);
          }
        },
      }),
      update: () => ({
        set: (value: unknown) => ({
          where: async () => {
            if (value && typeof value === "object") {
              updatedRows.push(value as Record<string, unknown>);
            }
            return { rowsAffected: 1 };
          },
        }),
      }),
    },
  }));

  mock.module("../utils", () => ({
    generateId: (() => {
      const ids = ["user-msg-temp", "assistant-msg-temp"];
      return () => ids.shift() || `generated-${Date.now()}`;
    })(),
  }));

  mock.module("../agent-adapters", () => ({
    createAdapter: () => ({
      chatStream: async function* (input: {
        model: string;
        messages: Array<{ role: string; content: unknown }>;
      }) {
        chatStreamCalls.push(input);
        yield "今天是周一。";
      },
    }),
  }));

  mock.module("./channelService", () => ({
    getResolvedChannelForConversation: async () => ({
      channel: {
        provider: "anthropic",
        baseUrl: "https://example.com",
      },
      apiKey: "test-key",
      modelId: "claude-3-7-sonnet",
    }),
  }));

  mock.module("./attachmentService", () => ({
    buildAttachmentPayloadFromIds: async () => ({ images: [], textContext: "" }),
    linkAttachmentsToMessage: async () => {},
  }));

  mock.module("./settingsService", () => ({
    getSettingValues: async () => ({ "chat.systemPrompt": "Global prompt" }),
  }));

  mock.module("./agentService", () => ({
    runAgentWithConfig: async function* () {},
  }));

  try {
    const { streamMessage } = await import("./messageService");
    const stream = await streamMessage("user-1", {
      conversationId: "conv-1",
      content: "今天周几",
      mode: "chat",
    });

    const payloads = parseSsePayloads(await readStreamText(stream));

    expect(payloads[0]).toEqual({
      type: "live_status",
      status: "live",
      route: "local",
      label: "已使用本地时间",
    });
    expect(payloads[1]).toEqual({
      type: "delta",
      content: "今天是周一。",
    });
    expect(payloads.at(-1)?.type).toBe("done");

    expect(chatStreamCalls).toHaveLength(1);
    expect(chatStreamCalls[0]?.messages).toHaveLength(2);
    expect(chatStreamCalls[0]?.messages[0]).toMatchObject({
      role: "system",
    });
    expect(String(chatStreamCalls[0]?.messages[0]?.content || "")).toContain("Base system prompt");
    expect(String(chatStreamCalls[0]?.messages[0]?.content || "")).toContain("Local time context:");
    expect(chatStreamCalls[0]?.messages[1]).toEqual({
      role: "user",
      content: "今天周几",
    });

    const assistantUpdate = updatedRows.find((row) => typeof row.liveMetadata === "string");
    const storedLiveMetadata = JSON.parse(String(assistantUpdate?.liveMetadata || "{}"));
    expect(storedLiveMetadata.status).toBe("live");
    expect(storedLiveMetadata.route).toBe("local");
    expect(storedLiveMetadata.label).toBe("已使用本地时间");
    expect(storedLiveMetadata.sourceType).toBe("local");
  } finally {
    mock.restore();
  }
});

test("stream agent includes recent conversation context for follow-up turns", async () => {
  const conversationTable = {
    id: "conversation_id",
    userId: "conversation_user_id",
    channelId: "conversation_channel_id",
    modelId: "conversation_model_id",
    updatedAt: "conversation_updated_at",
    lastMode: "conversation_last_mode",
    runStatus: "conversation_run_status",
  };
  const messageTable = {
    id: "message_id",
    conversationId: "message_conversation_id",
    createdAt: "message_created_at",
  };
  const attachmentTable = {
    id: "attachment_id",
    messageId: "attachment_message_id",
    fileName: "attachment_file_name",
    fileType: "attachment_file_type",
    fileSize: "attachment_file_size",
  };

  const insertedRows: Array<Record<string, unknown>> = [];
  const updatedRows: Array<Record<string, unknown>> = [];
  const agentConfigs: Array<Record<string, unknown>> = [];

  mock.module("db", () => ({
    conversations: conversationTable,
    messages: messageTable,
    attachments: attachmentTable,
  }));

  mock.module("../db", () => ({
    db: {
      select: () => ({
        from: (table: unknown) => {
          if (table === conversationTable) {
            return {
              where: () => ({
                limit: async () => [
                  {
                    id: "conv-1",
                    userId: "user-1",
                    channelId: "channel-1",
                    modelId: "claude-3-7-sonnet",
                    systemPrompt: "Base system prompt",
                    forceWebSearch: false,
                    workspaceId: null,
                  },
                ],
              }),
            };
          }

          if (table === messageTable) {
            return {
              where: () => ({
                orderBy: async () => [
                  {
                    id: "user-msg-1",
                    conversationId: "conv-1",
                    role: "user",
                    content: "什么是 AI？",
                    attachments: null,
                    mode: "agent",
                    workspaceId: null,
                    contextPaths: null,
                    createdAt: new Date("2026-03-18T10:00:00.000Z"),
                  },
                  {
                    id: "assistant-msg-1",
                    conversationId: "conv-1",
                    role: "assistant",
                    content: "AI 是让机器模拟人类智能的技术。",
                    attachments: null,
                    mode: "agent",
                    workspaceId: null,
                    contextPaths: null,
                    createdAt: new Date("2026-03-18T10:00:01.000Z"),
                  },
                  {
                    id: "user-msg-2",
                    conversationId: "conv-1",
                    role: "user",
                    content: "那他能做什么",
                    attachments: null,
                    mode: "agent",
                    workspaceId: null,
                    contextPaths: null,
                    createdAt: new Date("2026-03-18T10:00:02.000Z"),
                  },
                ],
              }),
            };
          }

          if (table === attachmentTable) {
            return {
              where: async () => [],
            };
          }

          throw new Error("Unexpected table in select");
        },
      }),
      insert: () => ({
        values: async (value: unknown) => {
          if (value && typeof value === "object") {
            insertedRows.push(value as Record<string, unknown>);
          }
        },
      }),
      update: () => ({
        set: (value: unknown) => ({
          where: async () => {
            if (value && typeof value === "object") {
              updatedRows.push(value as Record<string, unknown>);
            }
            return { rowsAffected: 1 };
          },
        }),
      }),
    },
  }));

  mock.module("../utils", () => ({
    generateId: (() => {
      const ids = ["user-msg-2", "assistant-msg-2"];
      return () => ids.shift() || `generated-${Date.now()}`;
    })(),
  }));

  mock.module("./channelService", () => ({
    getResolvedChannelForConversation: async () => ({
      channel: {
        provider: "anthropic",
        baseUrl: "https://example.com",
      },
      apiKey: "test-key",
      modelId: "claude-3-7-sonnet",
    }),
  }));

  mock.module("./attachmentService", () => ({
    buildAttachmentPayloadFromIds: async () => ({ images: [], textContext: "", files: [] }),
    linkAttachmentsToMessage: async () => {},
  }));

  mock.module("./settingsService", () => ({
    getSettingValues: async () => ({ "chat.systemPrompt": "Global prompt" }),
  }));

  mock.module("./agentService", () => ({
    runAgentWithConfig: async function* (config: Record<string, unknown>) {
      agentConfigs.push(config);
      yield { type: "text", content: "它可以读写代码、调用工具并执行任务。" };
    },
  }));

  try {
    const { streamMessage } = await import("./messageService");
    const stream = await streamMessage("user-1", {
      conversationId: "conv-1",
      content: "那他能做什么",
      mode: "agent",
    });

    const payloads = parseSsePayloads(await readStreamText(stream));

    expect(payloads[0]).toEqual({
      type: "live_status",
      status: "offline",
      route: "direct_model",
    });
    expect(payloads[1]).toEqual({
      type: "delta",
      content: "它可以读写代码、调用工具并执行任务。",
    });
    expect(payloads.at(-1)).toMatchObject({
      type: "done",
      messageId: "assistant-msg-2",
      model: "claude-3-7-sonnet",
    });

    expect(agentConfigs).toHaveLength(1);
    expect(agentConfigs[0]?.prompt).toBe("那他能做什么");
    expect(agentConfigs[0]?.conversationHistory).toEqual([
      { role: "user", content: "什么是 AI？" },
      { role: "assistant", content: "AI 是让机器模拟人类智能的技术。" },
    ]);

    expect(insertedRows[1]).toMatchObject({
      id: "assistant-msg-2",
      conversationId: "conv-1",
      role: "assistant",
      mode: "agent",
    });
    expect(updatedRows.at(-1)).toMatchObject({
      runStatus: "completed",
    });
  } finally {
    mock.restore();
  }
});

test("regenerate falls back to the previous user message when assistant id is missing", async () => {
  const conversationTable = {
    id: "conversation_id",
    userId: "conversation_user_id",
    channelId: "conversation_channel_id",
    modelId: "conversation_model_id",
    updatedAt: "conversation_updated_at",
    lastMode: "conversation_last_mode",
    runStatus: "conversation_run_status",
  };
  const messageTable = {
    id: "message_id",
    conversationId: "message_conversation_id",
    createdAt: "message_created_at",
  };
  const attachmentTable = {
    id: "attachment_id",
    messageId: "attachment_message_id",
    fileName: "attachment_file_name",
    fileType: "attachment_file_type",
    fileSize: "attachment_file_size",
  };

  const insertedRows: Array<Record<string, unknown>> = [];
  const updatedRows: Array<Record<string, unknown>> = [];
  const chatStreamCalls: Array<{
    model: string;
    messages: Array<{ role: string; content: unknown }>;
  }> = [];
  let messageSelectCount = 0;

  const userMsg = {
    id: "user-msg-1",
    conversationId: "conv-1",
    role: "user",
    content: "OpenClaw 有什么能力？",
    attachments: null,
    mode: "chat",
    workspaceId: null,
    contextPaths: null,
    createdAt: new Date("2026-03-18T10:00:00.000Z"),
  };

  mock.module("db", () => ({
    conversations: conversationTable,
    messages: messageTable,
    attachments: attachmentTable,
  }));

  mock.module("../db", () => ({
    db: {
      select: () => ({
        from: (table: unknown) => {
          if (table === messageTable) {
            messageSelectCount += 1;
            if (messageSelectCount === 1) {
              return { where: async () => [] };
            }
            if (messageSelectCount === 2) {
              return {
                where: async () => [userMsg],
              };
            }
            return {
              where: () =>
                Object.assign(Promise.resolve([userMsg]), {
                  orderBy: async () => [userMsg],
                }),
            };
          }

          if (table === conversationTable) {
            return {
              where: () => ({
                limit: async () => [
                  {
                    id: "conv-1",
                    userId: "user-1",
                    channelId: "channel-1",
                    modelId: "claude-3-7-sonnet",
                    systemPrompt: "Base system prompt",
                    forceWebSearch: false,
                    workspaceId: null,
                  },
                ],
              }),
            };
          }

          if (table === attachmentTable) {
            return {
              where: async () => [],
            };
          }

          throw new Error("Unexpected table in select");
        },
      }),
      insert: () => ({
        values: async (value: unknown) => {
          if (value && typeof value === "object") {
            insertedRows.push(value as Record<string, unknown>);
          }
        },
      }),
      update: (_table: unknown) => ({
        set: (value: unknown) => ({
          where: async () => {
            if (value && typeof value === "object") {
              updatedRows.push(value as Record<string, unknown>);
            }
            return { rowsAffected: 1 };
          },
        }),
      }),
    },
  }));

  mock.module("../utils", () => ({
    generateId: (() => {
      const ids = ["assistant-msg-fallback"];
      return () => ids.shift() || `generated-${Date.now()}`;
    })(),
  }));

  mock.module("../agent-adapters", () => ({
    createAdapter: () => ({
      chatStream: async function* (input: {
        model: string;
        messages: Array<{ role: string; content: unknown }>;
      }) {
        chatStreamCalls.push(input);
        yield "回退后的回答";
      },
    }),
  }));

  mock.module("./channelService", () => ({
    getResolvedChannelForConversation: async () => ({
      channel: {
        provider: "anthropic",
        baseUrl: "https://example.com",
      },
      apiKey: "test-key",
      modelId: "claude-3-7-sonnet",
    }),
  }));

  mock.module("./attachmentService", () => ({
    buildAttachmentPayloadFromIds: async () => ({ images: [], textContext: "" }),
    linkAttachmentsToMessage: async () => {},
  }));

  mock.module("./settingsService", () => ({
    getSettingValues: async () => ({ "chat.systemPrompt": "Global prompt" }),
  }));

  mock.module("./agentService", () => ({
    runAgentWithConfig: async function* () {},
  }));

  try {
    const { regenerateMessage } = await import("./messageService");
    const stream = await regenerateMessage("user-1", "missing-assistant-id", {
      fallbackUserMessageId: "user-msg-1",
      fallbackUserContent: "OpenClaw 有什么能力？",
    });
    const payloads = parseSsePayloads(await readStreamText(stream));

    expect(payloads[0]).toEqual({
      type: "live_status",
      status: "offline",
      route: "direct_model",
    });
    expect(payloads[1]).toEqual({
      type: "delta",
      content: "回退后的回答",
    });
    expect(payloads.at(-1)).toMatchObject({
      type: "done",
      messageId: "assistant-msg-fallback",
      model: "claude-3-7-sonnet",
    });

    expect(updatedRows[0]).toMatchObject({ content: "OpenClaw 有什么能力？" });
    expect(insertedRows[0]).toMatchObject({
      id: "assistant-msg-fallback",
      conversationId: "conv-1",
      role: "assistant",
      content: "",
      mode: "chat",
      model: "claude-3-7-sonnet",
    });
    expect(chatStreamCalls).toHaveLength(1);
  } finally {
    mock.restore();
  }
});

test("edit user message creates a new assistant reply when the user message is the conversation tail", async () => {
  const conversationTable = {
    id: "conversation_id",
    userId: "conversation_user_id",
    channelId: "conversation_channel_id",
    modelId: "conversation_model_id",
  };
  const messageTable = {
    id: "message_id",
    conversationId: "message_conversation_id",
    createdAt: "message_created_at",
  };
  const attachmentTable = {
    id: "attachment_id",
    messageId: "attachment_message_id",
    fileName: "attachment_file_name",
    fileType: "attachment_file_type",
    fileSize: "attachment_file_size",
  };

  const insertedRows: Array<Record<string, unknown>> = [];
  const updatedRows: Array<Record<string, unknown>> = [];
  const chatStreamCalls: Array<{
    model: string;
    messages: Array<{ role: string; content: unknown }>;
  }> = [];

  mock.module("db", () => ({
    conversations: conversationTable,
    messages: messageTable,
    attachments: attachmentTable,
  }));

  mock.module("../db", () => ({
    db: {
      select: () => ({
        from: (table: unknown) => {
          if (table === messageTable) {
            const userMsg = {
              id: "user-msg-1",
              conversationId: "conv-1",
              role: "user",
              content: "旧问题",
              attachments: null,
              mode: "chat",
              workspaceId: null,
              contextPaths: null,
              createdAt: new Date("2026-03-18T10:00:00.000Z"),
            };
            return {
              where: () =>
                Object.assign(Promise.resolve([userMsg]), {
                  orderBy: async () => [userMsg],
                }),
            };
          }

          if (table === conversationTable) {
            return {
              where: () => ({
                limit: async () => [
                  {
                    id: "conv-1",
                    userId: "user-1",
                    channelId: "channel-1",
                    modelId: "claude-3-7-sonnet",
                    systemPrompt: "Base system prompt",
                    forceWebSearch: false,
                    workspaceId: null,
                  },
                ],
              }),
            };
          }

          if (table === attachmentTable) {
            return {
              where: async () => [],
            };
          }

          throw new Error("Unexpected table in select");
        },
      }),
      insert: () => ({
        values: async (value: unknown) => {
          if (value && typeof value === "object") {
            insertedRows.push(value as Record<string, unknown>);
          }
        },
      }),
      update: (_table: unknown) => ({
        set: (value: unknown) => ({
          where: async () => {
            if (value && typeof value === "object") {
              updatedRows.push(value as Record<string, unknown>);
            }
            return { rowsAffected: 1 };
          },
        }),
      }),
    },
  }));

  mock.module("../utils", () => ({
    generateId: (() => {
      const ids = ["assistant-msg-new"];
      return () => ids.shift() || `generated-${Date.now()}`;
    })(),
  }));

  mock.module("../agent-adapters", () => ({
    createAdapter: () => ({
      chatStream: async function* (input: {
        model: string;
        messages: Array<{ role: string; content: unknown }>;
      }) {
        chatStreamCalls.push(input);
        yield "新的回答";
      },
    }),
  }));

  mock.module("./channelService", () => ({
    getResolvedChannelForConversation: async () => ({
      channel: {
        provider: "anthropic",
        baseUrl: "https://example.com",
      },
      apiKey: "test-key",
      modelId: "claude-3-7-sonnet",
    }),
  }));

  mock.module("./attachmentService", () => ({
    buildAttachmentPayloadFromIds: async () => ({ images: [], textContext: "" }),
    linkAttachmentsToMessage: async () => {},
  }));

  mock.module("./settingsService", () => ({
    getSettingValues: async () => ({ "chat.systemPrompt": "Global prompt" }),
  }));

  mock.module("./agentService", () => ({
    runAgentWithConfig: async function* () {},
  }));

  try {
    const { editUserMessage } = await import("./messageService");
    const stream = await editUserMessage("user-1", "user-msg-1", "新问题");
    const payloads = parseSsePayloads(await readStreamText(stream));

    expect(payloads[0]).toEqual({
      type: "live_status",
      status: "offline",
      route: "direct_model",
    });
    expect(payloads[1]).toEqual({
      type: "delta",
      content: "新的回答",
    });
    expect(payloads.at(-1)).toMatchObject({
      type: "done",
      messageId: "assistant-msg-new",
      model: "claude-3-7-sonnet",
    });

    expect(updatedRows[0]).toMatchObject({ content: "新问题" });
    expect(insertedRows).toHaveLength(1);
    expect(insertedRows[0]).toMatchObject({
      id: "assistant-msg-new",
      conversationId: "conv-1",
      role: "assistant",
      content: "",
      mode: "chat",
      model: "claude-3-7-sonnet",
    });

    expect(chatStreamCalls).toHaveLength(1);
    expect(chatStreamCalls[0]?.messages.at(-1)).toEqual({
      role: "user",
      content: "新问题",
    });
  } finally {
    mock.restore();
  }
});
