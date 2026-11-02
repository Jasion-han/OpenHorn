import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { ChatStreamTruncatedError } from "adapters";
import { conversations, messages, users } from "db";
import { asc, eq } from "drizzle-orm";
import * as realAgentAdaptersNs from "../agent-adapters";
import { db } from "../db";
import * as realChannelServiceNs from "./channelService";
import {
  completeChatFromSidecar,
  editUserMessage,
  regenerateMessage,
  sendMessage,
  streamMessage,
} from "./messageService";

// Bun module mocks are global. Preserve/restore the real namespace so running
// this file with other service suites cannot leak its provider into them.
const realAgentAdapters = { ...realAgentAdaptersNs };
const realChannelService = { ...realChannelServiceNs };
const partial = "```openui\nroot = Card(";
const usage = { promptTokens: 11, completionTokens: 7, totalTokens: 18 };
let output = partial;
let truncated = true;

beforeAll(() => {
  mock.module("./channelService", () => ({
    ...realChannelService,
    getResolvedChannelForConversation: async () => ({
      channel: { id: "truncation-fixture", protocol: "openai", baseUrl: null },
      apiKey: "fixture-key",
      modelId: "fixture-model",
    }),
  }));
  mock.module("../agent-adapters", () => ({
    ...realAgentAdapters,
    createAdapter: () => ({
      chatStream: async function* () {
        if (output) yield output;
        if (truncated) throw new ChatStreamTruncatedError("length", usage);
        return usage;
      },
    }),
  }));
});

afterAll(() => {
  mock.module("./channelService", () => realChannelService);
  mock.module("../agent-adapters", () => realAgentAdapters);
});

async function fixture(withReply = true) {
  output = partial;
  truncated = true;
  const userId = crypto.randomUUID();
  const conversationId = crypto.randomUUID();
  const userMessageId = crypto.randomUUID();
  const assistantMessageId = crypto.randomUUID();
  const at = Date.now() - 60_000;
  await db.insert(users).values({
    id: userId,
    email: `${userId}@test.local`,
    username: "u",
    passwordHash: "x",
    createdAt: new Date(at),
    updatedAt: new Date(at),
  });
  await db.insert(conversations).values({
    id: conversationId,
    userId,
    title: "truncation",
    contextLength: 4096,
    defaultMode: "chat",
    lastMode: "chat",
    isPinned: false,
    forceWebSearch: false,
    createdAt: new Date(at),
    updatedAt: new Date(at),
  });
  await db.insert(messages).values({
    id: userMessageId,
    conversationId,
    role: "user",
    content: "question",
    mode: "chat",
    createdAt: new Date(at),
  });
  if (withReply)
    await db.insert(messages).values({
      id: assistantMessageId,
      conversationId,
      role: "assistant",
      content: "previous answer",
      mode: "chat",
      finishReason: "stopped",
      usage: JSON.stringify({ promptTokens: 1, completionTokens: 2, totalTokens: 3 }),
      createdAt: new Date(at + 1000),
    });
  return {
    userId,
    conversationId,
    userMessageId,
    assistantMessageId,
    async cleanup() {
      await db.delete(messages).where(eq(messages.conversationId, conversationId));
      await db.delete(conversations).where(eq(conversations.id, conversationId));
      await db.delete(users).where(eq(users.id, userId));
    },
  };
}

async function rows(conversationId: string) {
  return db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(asc(messages.createdAt));
}

async function events(stream: ReadableStream) {
  const raw = await new Response(stream).text();
  return raw
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>);
}

test("non-streaming Chat retains explicit truncation content, usage and persisted state", async () => {
  const ids = await fixture();
  try {
    const result = await sendMessage(ids.userId, {
      conversationId: ids.conversationId,
      content: "another question",
    });
    expect(result.errorCode).toBe("response_truncated");
    expect(result.assistantMessage.content).toBe(partial);
    expect(result.assistantMessage.finishReason).toBe("length");
    expect(result.assistantMessage.usage).toEqual(usage);
    const saved = (await rows(ids.conversationId)).find(
      (row) => row.id === result.assistantMessage.id,
    );
    expect(saved?.content).toBe(partial);
    expect(saved?.finishReason).toBe("length");
    expect(JSON.parse(saved?.usage ?? "null")).toEqual(usage);
  } finally {
    await ids.cleanup();
  }
});

for (const operation of ["send", "edit", "edit-tail", "retry"] as const) {
  test(`Chat ${operation} persists partial and usage before one identifiable truncation event`, async () => {
    const ids = await fixture(operation !== "edit-tail");
    try {
      const stream =
        operation === "send"
          ? await streamMessage(ids.userId, {
              conversationId: ids.conversationId,
              content: "another question",
              mode: "chat",
            })
          : operation === "retry"
            ? await regenerateMessage(ids.userId, ids.assistantMessageId)
            : await editUserMessage(ids.userId, ids.userMessageId, "edited question");
      const received = await events(stream);
      const terminal = received.filter((event) => event.type === "error" || event.type === "done");
      expect(terminal).toHaveLength(1);
      expect(terminal[0]).toMatchObject({
        type: "error",
        errorCode: "response_truncated",
        content: partial,
        model: "fixture-model",
        usage,
      });
      const savedRows = await rows(ids.conversationId);
      const saved = savedRows.find((row) => row.id === terminal[0]?.messageId);
      expect(saved?.role).toBe("assistant");
      expect(saved?.content).toBe(partial);
      expect(saved?.finishReason).toBe("length");
      expect(JSON.parse(saved?.usage ?? "null")).toEqual(usage);
      if (operation === "edit" || operation === "edit-tail")
        expect(savedRows.find((row) => row.id === ids.userMessageId)?.content).toBe(
          "edited question",
        );
      if (operation === "retry" || operation === "edit")
        expect(terminal[0]?.messageId).toBe(ids.assistantMessageId);
    } finally {
      await ids.cleanup();
    }
  });
}

test("zero-output truncated retry keeps the previous reply and its own terminal metadata", async () => {
  const ids = await fixture();
  try {
    output = "";
    const received = await events(await regenerateMessage(ids.userId, ids.assistantMessageId));
    expect(received[received.length - 1]).toMatchObject({
      type: "error",
      errorCode: "response_truncated",
      content: "",
      messageId: ids.assistantMessageId,
    });
    const saved = (await rows(ids.conversationId)).find((row) => row.id === ids.assistantMessageId);
    expect(saved?.content).toBe("previous answer");
    expect(saved?.finishReason).toBe("stopped");
    expect(JSON.parse(saved?.usage ?? "null")).toEqual({
      promptTokens: 1,
      completionTokens: 2,
      totalTokens: 3,
    });
  } finally {
    await ids.cleanup();
  }
});

test("normal replacement clears a previous truncation and stores normal generator usage", async () => {
  const ids = await fixture();
  try {
    await db
      .update(messages)
      .set({ finishReason: "length" })
      .where(eq(messages.id, ids.assistantMessageId));
    output = "complete answer";
    truncated = false;
    const received = await events(await regenerateMessage(ids.userId, ids.assistantMessageId));
    expect(received[received.length - 1]?.type).toBe("done");
    const saved = (await rows(ids.conversationId)).find((row) => row.id === ids.assistantMessageId);
    expect(saved?.content).toBe(output);
    expect(saved?.finishReason).toBe(null);
    expect(JSON.parse(saved?.usage ?? "null")).toEqual(usage);
  } finally {
    await ids.cleanup();
  }
});

test("sidecar Chat completion round-trips length and clears it on normal replacement", async () => {
  const ids = await fixture();
  try {
    const complete = {
      assistantMessageId: ids.assistantMessageId,
      conversationId: ids.conversationId,
      content: partial,
      model: "fixture-model",
      usage,
      finishReason: "length",
    };
    await completeChatFromSidecar(ids.userId, complete);
    let saved = (await rows(ids.conversationId)).find((row) => row.id === ids.assistantMessageId);
    expect(saved?.content).toBe(partial);
    expect(saved?.finishReason).toBe("length");
    expect(JSON.parse(saved?.usage ?? "null")).toEqual(usage);
    let denied = false;
    try {
      await completeChatFromSidecar(crypto.randomUUID(), complete);
    } catch {
      denied = true;
    }
    expect(denied).toBe(true);
    await completeChatFromSidecar(ids.userId, {
      ...complete,
      content: "complete",
      finishReason: undefined,
    });
    saved = (await rows(ids.conversationId)).find((row) => row.id === ids.assistantMessageId);
    expect(saved?.content).toBe("complete");
    expect(saved?.finishReason).toBe(null);
  } finally {
    await ids.cleanup();
  }
});
