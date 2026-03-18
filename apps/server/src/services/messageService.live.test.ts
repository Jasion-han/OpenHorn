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
        set: () => ({
          where: async () => ({ rowsAffected: 1 }),
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

    const storedLiveMetadata = JSON.parse(String(insertedRows.at(-1)?.liveMetadata || "{}"));
    expect(storedLiveMetadata.status).toBe("live");
    expect(storedLiveMetadata.route).toBe("local");
    expect(storedLiveMetadata.label).toBe("已使用本地时间");
    expect(storedLiveMetadata.sourceType).toBe("local");
  } finally {
    mock.restore();
  }
});
