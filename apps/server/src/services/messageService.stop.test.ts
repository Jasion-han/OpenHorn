import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { conversations, messages, users } from "db";
import { asc, eq } from "drizzle-orm";
// Bun's mock.module() is process-global and cannot be unregistered: snapshot the
// real modules at evaluation time and re-register them in afterAll, or every
// later test file in the process sees the fakes.
import * as realAgentAdaptersNs from "../agent-adapters";
import { db } from "../db";
import * as realChannelServiceNs from "./channelService";
import {
  completeChatFromSidecar,
  editUserMessage,
  regenerateMessage,
  syncSidecarMessages,
} from "./messageService";

const realAgentAdapters = { ...realAgentAdaptersNs };
const realChannelService = { ...realChannelServiceNs };

/**
 * Stop means "stop generating", not "undo this turn": a reply stopped mid-stream
 * is persisted as far as it got, a regenerate stopped before any output keeps
 * the previous reply, and a stopped agent turn is stored with its partial steps
 * and a "cancelled" run.
 */

// What the fake provider streams before it waits to be aborted.
let streamedChunks: string[] = [];
let streamEnded: Promise<void> = Promise.resolve();

beforeAll(() => {
  mock.module("./channelService", () => ({
    ...realChannelService,
    getResolvedChannelForConversation: async () => ({
      channel: { id: "stop-test-channel", protocol: "openai", baseUrl: null },
      apiKey: "test-key",
      modelId: "test-model",
    }),
  }));
  mock.module("../agent-adapters", () => ({
    ...realAgentAdapters,
    createAdapter: () => ({
      chatStream: (options: { signal?: AbortSignal }) => {
        let markEnded = () => {};
        streamEnded = new Promise<void>((resolve) => {
          markEnded = resolve;
        });
        const chunks = streamedChunks;
        return (async function* () {
          try {
            for (const chunk of chunks) yield chunk;
            // Keep "generating" until the client stops the request.
            await new Promise<void>((resolve) => {
              if (options.signal?.aborted) return resolve();
              options.signal?.addEventListener("abort", () => resolve());
            });
            throw new DOMException("The operation was aborted.", "AbortError");
          } finally {
            markEnded();
          }
        })();
      },
    }),
  }));
});

afterAll(() => {
  mock.module("./channelService", () => realChannelService);
  mock.module("../agent-adapters", () => realAgentAdapters);
});

async function seed() {
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
    title: "stop",
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
  await db.insert(messages).values({
    id: assistantMessageId,
    conversationId,
    role: "assistant",
    content: "previous answer",
    mode: "chat",
    createdAt: new Date(at + 1000),
  });
  return { userId, conversationId, userMessageId, assistantMessageId };
}

async function cleanup(userId: string, conversationId: string) {
  await db.delete(messages).where(eq(messages.conversationId, conversationId));
  await db.delete(conversations).where(eq(conversations.id, conversationId));
  await db.delete(users).where(eq(users.id, userId));
}

/** Reads the SSE stream until `deltas` deltas arrived, then stops it like the client's Stop. */
async function stopAfterDeltas(stream: ReadableStream, deltas: number) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let raw = "";
  while ((raw.match(/"type":"delta"/g) ?? []).length < deltas) {
    const { done, value } = await reader.read();
    if (done) break;
    raw += decoder.decode(value, { stream: true });
  }
  await reader.cancel();
  await streamEnded;
}

/** Waits for the handler's post-stream write to settle. */
async function readRow(id: string, until: (content: string) => boolean) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const [row] = await db.select().from(messages).where(eq(messages.id, id));
    if (row && until(row.content)) return row;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const [row] = await db.select().from(messages).where(eq(messages.id, id));
  return row;
}

test("a chat regenerate stopped mid-stream persists what streamed as the new reply", async () => {
  const ids = await seed();
  try {
    streamedChunks = ["half ", "an answer"];
    await stopAfterDeltas(await regenerateMessage(ids.userId, ids.assistantMessageId), 2);
    const row = await readRow(ids.assistantMessageId, (c) => c !== "previous answer");
    expect(row?.content).toBe("half an answer");
    expect(row?.finishReason).toBe("stopped");
  } finally {
    await cleanup(ids.userId, ids.conversationId);
  }
});

test("a chat regenerate stopped before any output keeps the previous reply", async () => {
  const ids = await seed();
  try {
    streamedChunks = [];
    await stopAfterDeltas(await regenerateMessage(ids.userId, ids.assistantMessageId), 0);
    // Give a (wrong) write the chance to land before asserting it did not.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const [row] = await db.select().from(messages).where(eq(messages.id, ids.assistantMessageId));
    expect(row?.content).toBe("previous answer");
    expect(row?.finishReason).toBe(null);
  } finally {
    await cleanup(ids.userId, ids.conversationId);
  }
});

test("a chat edit-and-resend stopped mid-stream keeps the edited question and the partial reply", async () => {
  const ids = await seed();
  try {
    streamedChunks = ["partial"];
    await stopAfterDeltas(await editUserMessage(ids.userId, ids.userMessageId, "edited"), 1);
    const row = await readRow(ids.assistantMessageId, (c) => c !== "previous answer");
    expect(row?.content).toBe("partial");
    expect(row?.finishReason).toBe("stopped");
    const [question] = await db.select().from(messages).where(eq(messages.id, ids.userMessageId));
    expect(question?.content).toBe("edited");
  } finally {
    await cleanup(ids.userId, ids.conversationId);
  }
});

test("a stopped agent turn is stored with its partial steps and a cancelled run", async () => {
  const ids = await seed();
  try {
    const agentRun = {
      status: "cancelled",
      summary: "",
      steps: [
        { type: "tool_start", toolName: "Read" },
        { type: "text", content: "first half " },
      ],
    };
    const result = await syncSidecarMessages(ids.userId, {
      conversationId: ids.conversationId,
      userContent: "new question",
      assistantContent: "first half ",
      agentRun,
    });
    const rows = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, ids.conversationId))
      .orderBy(asc(messages.createdAt));
    const question = rows.find((r) => r.id === result.userMessageId);
    const reply = rows.find((r) => r.id === result.assistantMessageId);
    expect(question?.content).toBe("new question");
    expect(reply?.content).toBe("first half");
    expect(JSON.parse(reply?.agentRun ?? "null")).toEqual(agentRun);
    expect(reply?.finishReason).toBe("stopped");
  } finally {
    await cleanup(ids.userId, ids.conversationId);
  }
});

test("a chat reply completed as stopped keeps that state; completing it normally clears it", async () => {
  const ids = await seed();
  try {
    const complete = (finishReason?: string) =>
      completeChatFromSidecar(ids.userId, {
        assistantMessageId: ids.assistantMessageId,
        conversationId: ids.conversationId,
        content: "partial",
        finishReason,
      });
    const read = async () =>
      (await db.select().from(messages).where(eq(messages.id, ids.assistantMessageId)))[0];
    await complete("stopped");
    expect((await read())?.finishReason).toBe("stopped");
    await complete();
    expect((await read())?.finishReason).toBe(null);
  } finally {
    await cleanup(ids.userId, ids.conversationId);
  }
});

test("regenerating an agent reply in place clears its earlier stop once it finishes", async () => {
  const ids = await seed();
  try {
    const sync = (status: string) =>
      syncSidecarMessages(ids.userId, {
        conversationId: ids.conversationId,
        userContent: "question",
        assistantContent: "",
        agentRun: { status, summary: "", steps: [{ type: "text", content: "answer" }] },
        userMessageId: ids.userMessageId,
        assistantMessageId: ids.assistantMessageId,
      });
    const read = async () =>
      (await db.select().from(messages).where(eq(messages.id, ids.assistantMessageId)))[0];
    await sync("cancelled");
    expect((await read())?.finishReason).toBe("stopped");
    await sync("completed");
    expect((await read())?.finishReason).toBe(null);
  } finally {
    await cleanup(ids.userId, ids.conversationId);
  }
});
