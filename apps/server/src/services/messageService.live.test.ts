import { afterAll, expect, mock, test } from "bun:test";
// These `import * as` namespaces are LIVE views: once this file's in-test `mock.module(...)`
// calls run, the namespaces would reflect the mocked exports. So snapshot each into a plain
// object at module-eval time (before any test runs a mock) to capture the REAL modules.
// `mock.restore()` does NOT unregister `mock.module()`, so we re-register these real snapshots
// in afterAll to stop this file's mocks leaking into the next test file (the
// "db.delete is not a function" baseline noise).
import * as realDbSchemaNs from "db";
import * as realAgentAdaptersNs from "../agent-adapters";
import * as realDbNs from "../db";
import * as realUtilsNs from "../utils";
import * as realAgentServiceNs from "./agentService";
import * as realAgentStreamTimeoutsNs from "./agentStreamTimeouts";
import * as realAgentTaskServiceNs from "./agentTaskService";
import * as realAttachmentServiceNs from "./attachmentService";
import * as realChannelAgentCheckServiceNs from "./channelAgentCheckService";
import * as realChannelServiceNs from "./channelService";
import * as realSettingsServiceNs from "./settingsService";

const realDbSchema = { ...realDbSchemaNs };
const realDb = { ...realDbNs };
const realAgentAdapters = { ...realAgentAdaptersNs };
const realUtils = { ...realUtilsNs };
const realAgentService = { ...realAgentServiceNs };
const realAgentStreamTimeouts = { ...realAgentStreamTimeoutsNs };
const realAgentTaskService = { ...realAgentTaskServiceNs };
const realAttachmentService = { ...realAttachmentServiceNs };
const realChannelAgentCheckService = { ...realChannelAgentCheckServiceNs };
const realChannelService = { ...realChannelServiceNs };
const realSettingsService = { ...realSettingsServiceNs };

afterAll(() => {
  mock.module("db", () => realDbSchema);
  mock.module("../db", () => realDb);
  mock.module("../agent-adapters", () => realAgentAdapters);
  mock.module("../utils", () => realUtils);
  mock.module("./agentService", () => realAgentService);
  mock.module("./agentStreamTimeouts", () => realAgentStreamTimeouts);
  mock.module("./agentTaskService", () => realAgentTaskService);
  mock.module("./attachmentService", () => realAttachmentService);
  mock.module("./channelAgentCheckService", () => realChannelAgentCheckService);
  mock.module("./channelService", () => realChannelService);
  mock.module("./settingsService", () => realSettingsService);
});

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
    ...realDbSchema,
    agentSessions: {},
    agentTasks: {},
    channelModels: {},
    channels: {},
    conversations: conversationTable,
    messages: messageTable,
    attachments: attachmentTable,
    users: {},
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
    encrypt: (value: string) => value,
    decrypt: (value: string) => value,
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
    getChannels: async () => [],
    getResolvedChannelForConversation: async () => ({
      channel: {
        provider: "anthropic",
        baseUrl: "https://example.com",
      },
      apiKey: "test-key",
      modelId: "claude-3-7-sonnet",
    }),
    getChannelRuntimeCredentialsById: async () => ({
      channel: { baseUrl: "https://example.com" },
      apiKey: "test-key",
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
    const { streamMessage } = await import(`./messageService?agent-context=${crypto.randomUUID()}`);
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
    ...realDbSchema,
    agentSessions: {},
    agentTasks: {},
    channelModels: {},
    channels: {},
    conversations: conversationTable,
    messages: messageTable,
    attachments: attachmentTable,
    users: {},
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
    encrypt: (value: string) => value,
    decrypt: (value: string) => value,
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
    getChannels: async () => [],
    getResolvedChannelForConversation: async () => ({
      channel: {
        provider: "anthropic",
        baseUrl: "https://example.com",
      },
      apiKey: "test-key",
      modelId: "claude-3-7-sonnet",
    }),
    getChannelRuntimeCredentialsById: async () => ({
      channel: { baseUrl: "https://example.com" },
      apiKey: "test-key",
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
    ...realDbSchema,
    agentSessions: {},
    agentTasks: {},
    channelModels: {},
    channels: {},
    conversations: conversationTable,
    messages: messageTable,
    attachments: attachmentTable,
    users: {},
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
    encrypt: (value: string) => value,
    decrypt: (value: string) => value,
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
    getChannels: async () => [],
    getResolvedChannelForConversation: async () => ({
      channel: {
        provider: "anthropic",
        baseUrl: "https://example.com",
      },
      apiKey: "test-key",
      modelId: "claude-3-7-sonnet",
    }),
    getChannelRuntimeCredentialsById: async () => ({
      channel: { baseUrl: "https://example.com" },
      apiKey: "test-key",
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
    const { editUserMessage } = await import(`./messageService?edit-agent=${crypto.randomUUID()}`);
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

// The agent path of streamMessage / editUserMessage was refactored away from the
// old inline live_status/delta/done streaming (via runAgentWithConfig with a
// per-turn timeout guard + conversation history) to a task-backed flow: it now
// creates and plans an agent task (createTaskBackedAgentTurn) and emits a single
// terminal "done" payload carrying the task summary. The old streaming behavior
// (live_status, delta, timeout-abort, meta keepalive, fail-fast on incompatible
// channels, conversation-history injection) no longer exists on this path — that
// machinery moved to the task execution route (agent.ts /tasks/:id/execute),
// covered by agent.tasks.test.ts. These tests assert the current messageService
// glue against a mocked agentTaskService.
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

function mockDbSchema() {
  mock.module("db", () => ({
    ...realDbSchema,
    agentSessions: {},
    agentTasks: {},
    channelModels: {},
    channels: {},
    conversations: conversationTable,
    messages: messageTable,
    attachments: attachmentTable,
    users: {},
  }));
}

function mockCommonAgentServices() {
  mock.module("./channelService", () => ({
    getChannels: async () => [],
    getResolvedChannelForConversation: async () => ({
      channel: { id: "channel-1", provider: "anthropic", baseUrl: "https://example.com" },
      apiKey: "test-key",
      modelId: "claude-3-7-sonnet",
    }),
    getChannelRuntimeCredentialsById: async () => ({
      channel: { baseUrl: "https://example.com" },
      apiKey: "test-key",
    }),
  }));
  mock.module("./attachmentService", () => ({
    buildAttachmentPayloadFromIds: async () => ({ images: [], textContext: "", files: [] }),
    linkAttachmentsToMessage: async () => {},
  }));
  mock.module("./settingsService", () => ({
    getSettingValues: async () => ({}),
  }));
}

function buildTaskBackedServiceMock(options: {
  createInputs: Array<Record<string, unknown>>;
  detail: unknown;
  onCreateTask?: () => void;
}) {
  return {
    createAgentTask: async (_userId: string, input: Record<string, unknown>) => {
      options.onCreateTask?.();
      options.createInputs.push(input);
      return {
        id: "task-1",
        conversationId: "conv-1",
        channelId: input.channelId,
        modelId: input.modelId,
        goal: input.goal,
        complexity: input.complexity,
        uxMode: input.uxMode,
        requiresPlanApproval: input.requiresPlanApproval,
        autoStart: input.autoStart,
        status: "draft",
        attachments: input.attachments ?? [],
      };
    },
    updateAgentTaskStatus: async () => ({}),
    updateAgentRunStatus: async () => ({}),
    createAgentRun: async () => ({ id: "run-1" }),
    createAgentTaskEvent: async () => ({ id: "event-1" }),
    setAgentPlanSteps: async () => [],
    createAgentApprovalRequest: async () => ({
      id: "approval-1",
      title: "Approve task execution",
      type: "plan_approval",
    }),
    getAgentTaskDetail: async () => options.detail,
  };
}

test("stream agent mode routes to a task-backed turn and emits a single done payload", async () => {
  const insertedRows: Array<Record<string, unknown>> = [];
  const updatedRows: Array<Record<string, unknown>> = [];
  const createTaskInputs: Array<Record<string, unknown>> = [];

  const taskDetail = {
    task: {
      id: "task-1",
      conversationId: "conv-1",
      channelId: "channel-1",
      modelId: "claude-3-7-sonnet",
      status: "awaiting_approval",
      complexity: "standard",
      uxMode: "full",
      requiresPlanApproval: true,
      autoStart: true,
      goal: "那他能做什么",
      insight: { previewText: "Task is awaiting approval." },
    },
    runs: [{ id: "run-1", phase: "planning" }],
    approvals: [{ id: "approval-1", type: "plan_approval", status: "pending" }],
    planSteps: [],
    artifacts: [],
    events: [],
    runtime: null,
  };

  mockDbSchema();
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
    encrypt: (value: string) => value,
    decrypt: (value: string) => value,
    generateId: (() => {
      const ids = ["user-msg-2", "assistant-msg-2"];
      return () => ids.shift() || `generated-${Date.now()}`;
    })(),
  }));

  mockCommonAgentServices();
  mock.module("./agentTaskService", () =>
    buildTaskBackedServiceMock({ createInputs: createTaskInputs, detail: taskDetail }),
  );

  try {
    const { streamMessage } = await import(
      `./messageService?agent-task-backed=${crypto.randomUUID()}`
    );
    const stream = await streamMessage("user-1", {
      conversationId: "conv-1",
      content: "那他能做什么",
      mode: "agent",
    });

    const payloads = parseSsePayloads(await readStreamText(stream));

    // The agent path no longer streams live_status/delta tokens; it kicks off a
    // task-backed turn and emits exactly one done payload.
    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toMatchObject({
      type: "done",
      messageId: "assistant-msg-2",
      model: "claude-3-7-sonnet",
    });
    expect(payloads[0]?.agentRun).toMatchObject({
      taskId: "task-1",
      taskStatus: "awaiting_approval",
      summary: "Task is awaiting approval.",
    });

    // Uses the conversation-selected channel and model when creating the task.
    expect(createTaskInputs).toHaveLength(1);
    expect(createTaskInputs[0]).toMatchObject({
      conversationId: "conv-1",
      channelId: "channel-1",
      modelId: "claude-3-7-sonnet",
      goal: "那他能做什么",
    });

    // Assistant message is updated with the task summary + serialized agentRun.
    const assistantUpdate = updatedRows.find(
      (row) => row.mode === "agent" && typeof row.agentRun === "string",
    );
    expect(assistantUpdate).toMatchObject({
      content: "Task is awaiting approval.",
      model: "claude-3-7-sonnet",
      mode: "agent",
    });
    expect(JSON.parse(String(assistantUpdate?.agentRun))).toMatchObject({ taskId: "task-1" });

    // Conversation runStatus follows the task status.
    const conversationUpdate = updatedRows.find((row) => row.runStatus === "awaiting_approval");
    expect(conversationUpdate).toMatchObject({ runStatus: "awaiting_approval", lastMode: "agent" });
  } finally {
    mock.restore();
  }
});

test("stream agent mode resets conversation runStatus to failed when the task turn throws", async () => {
  const updatedRows: Array<Record<string, unknown>> = [];
  const createTaskInputs: Array<Record<string, unknown>> = [];

  mockDbSchema();
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
          throw new Error("Unexpected table in select");
        },
      }),
      insert: () => ({ values: async () => {} }),
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
    encrypt: (value: string) => value,
    decrypt: (value: string) => value,
    generateId: (() => {
      const ids = ["user-msg-2", "assistant-msg-2"];
      return () => ids.shift() || `generated-${Date.now()}`;
    })(),
  }));

  mockCommonAgentServices();
  mock.module("./agentTaskService", () => ({
    ...buildTaskBackedServiceMock({ createInputs: createTaskInputs, detail: null }),
    createAgentTask: async () => {
      throw new Error("渠道解析失败");
    },
  }));

  try {
    const { streamMessage } = await import(
      `./messageService?agent-task-fail=${crypto.randomUUID()}`
    );
    const stream = await streamMessage("user-1", {
      conversationId: "conv-1",
      content: "那他能做什么",
      mode: "agent",
    });

    const payloads = parseSsePayloads(await readStreamText(stream));

    // The turn throws before producing output; the SSE stream surfaces the error.
    expect(payloads.at(-1)).toMatchObject({ type: "error", message: "渠道解析失败" });

    // The conversation is unstuck from "running" back to "failed".
    const failedUpdate = updatedRows.find((row) => row.runStatus === "failed");
    expect(failedUpdate).toMatchObject({ runStatus: "failed" });
  } finally {
    mock.restore();
  }
});

test("edit agent user message returns the task-backed summary instead of streaming deltas", async () => {
  const updatedRows: Array<Record<string, unknown>> = [];
  const createTaskInputs: Array<Record<string, unknown>> = [];

  const userMsg = {
    id: "user-msg-1",
    conversationId: "conv-1",
    role: "user",
    content: "旧问题",
    attachments: null,
    mode: "agent",
    workspaceId: null,
    contextPaths: null,
    createdAt: new Date("2026-03-18T10:00:00.000Z"),
  };
  const assistantMsg = {
    id: "assistant-msg-1",
    conversationId: "conv-1",
    role: "assistant",
    content: "旧回答",
    attachments: null,
    mode: "agent",
    workspaceId: null,
    contextPaths: null,
    createdAt: new Date("2026-03-18T10:00:01.000Z"),
  };

  const taskDetail = {
    task: {
      id: "task-1",
      conversationId: "conv-1",
      channelId: "channel-1",
      modelId: "claude-3-7-sonnet",
      status: "completed",
      complexity: "standard",
      uxMode: "full",
      requiresPlanApproval: true,
      autoStart: true,
      goal: "新问题",
      insight: { previewText: "已完成本轮执行。" },
    },
    runs: [{ id: "run-1", phase: "execution" }],
    approvals: [],
    planSteps: [],
    artifacts: [],
    events: [],
    runtime: null,
  };

  mockDbSchema();
  mock.module("../db", () => ({
    db: {
      select: () => ({
        from: (table: unknown) => {
          if (table === messageTable) {
            return {
              where: () =>
                Object.assign(Promise.resolve([userMsg]), {
                  orderBy: async () => [userMsg, assistantMsg],
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
            return { where: async () => [] };
          }
          throw new Error("Unexpected table in select");
        },
      }),
      insert: () => ({ values: async () => {} }),
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
    encrypt: (value: string) => value,
    decrypt: (value: string) => value,
    generateId: () => `generated-${Date.now()}`,
  }));

  mockCommonAgentServices();
  mock.module("./agentTaskService", () =>
    buildTaskBackedServiceMock({ createInputs: createTaskInputs, detail: taskDetail }),
  );

  try {
    const { editUserMessage } = await import(
      `./messageService?edit-agent-task=${crypto.randomUUID()}`
    );
    const stream = await editUserMessage("user-1", "user-msg-1", "新问题");
    const payloads = parseSsePayloads(await readStreamText(stream));

    // Edit of an agent turn returns the task summary via a single done payload —
    // it does not stream live_status/delta chunks.
    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toMatchObject({
      type: "done",
      messageId: "assistant-msg-1",
      model: "claude-3-7-sonnet",
    });
    expect(payloads[0]?.agentRun).toMatchObject({ taskId: "task-1", summary: "已完成本轮执行。" });

    // The user message content is updated with the new prompt.
    expect(updatedRows.find((row) => row.content === "新问题")).toBeDefined();
    expect(createTaskInputs[0]).toMatchObject({ goal: "新问题" });

    // The existing assistant message is updated with the task summary.
    const assistantUpdate = updatedRows.find(
      (row) => row.mode === "agent" && typeof row.agentRun === "string",
    );
    expect(assistantUpdate).toMatchObject({
      content: "已完成本轮执行。",
      model: "claude-3-7-sonnet",
      mode: "agent",
    });
  } finally {
    mock.restore();
  }
});
