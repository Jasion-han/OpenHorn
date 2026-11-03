import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { conversations, messages, users } from "db";
import { eq } from "drizzle-orm";
import * as adaptersNamespace from "../agent-adapters";
import { client, db } from "../db";
import * as sseNamespace from "../utils/sse";
import * as channelsNamespace from "./channelService";
import { deleteConversation } from "./conversationService";
import {
  deleteMessage,
  editUserMessage,
  regenerateMessage,
  syncSidecarMessages,
} from "./messageService";

const realAdapters = { ...adaptersNamespace };
const realChannels = { ...channelsNamespace };
const realSse = { ...sseNamespace };

function gate() {
  let release!: () => void;
  let started!: () => void;
  return {
    wait: new Promise<void>((resolve) => {
      release = resolve;
    }),
    begun: new Promise<void>((resolve) => {
      started = resolve;
    }),
    release: () => release(),
    started: () => started(),
  };
}
type Gate = ReturnType<typeof gate>;
type Provider = { text: string; gate?: Gate; tail?: string };
let providers: Provider[] = [];
let providerSignals: Array<AbortSignal | undefined> = [];
let preparationGate: Gate | undefined;
let providerCalls = 0;
const handlers: Promise<void>[] = [];

beforeAll(() => {
  mock.module("./channelService", () => ({
    ...realChannels,
    getResolvedChannelForConversation: async () => {
      const pending = preparationGate;
      preparationGate = undefined;
      if (pending) {
        pending.started();
        await pending.wait;
      }
      return {
        channel: { id: "mutation-fixture", protocol: "openai", baseUrl: null },
        apiKey: "synthetic-only",
        modelId: "fixture-model",
      };
    },
  }));
  mock.module("../agent-adapters", () => ({
    ...realAdapters,
    createAdapter: () => ({
      chatStream: async function* (input: { signal?: AbortSignal }) {
        providerCalls++;
        providerSignals.push(input.signal);
        const current = providers.shift() ?? { text: "unexpected-provider" };
        yield current.text;
        current.gate?.started();
        // Intentionally acknowledge abort only after the test releases the
        // provider: a slow cancellation must not become a stale final save.
        if (current.gate) await current.gate.wait;
        if (current.tail) yield current.tail;
        if (input.signal?.aborted) throw new DOMException("Stopped", "AbortError");
        return { promptTokens: 10, completionTokens: current.text.length, totalTokens: 20 };
      },
    }),
  }));
  mock.module("../utils/sse", () => ({
    ...realSse,
    createSseStream: (handler: Parameters<typeof realSse.createSseStream>[0]) => {
      let settled!: () => void;
      handlers.push(
        new Promise<void>((resolve) => {
          settled = resolve;
        }),
      );
      return realSse.createSseStream(async (...args) => {
        try {
          await handler(...args);
        } finally {
          settled();
        }
      });
    },
  }));
});

afterAll(() => {
  mock.module("./channelService", () => realChannels);
  mock.module("../agent-adapters", () => realAdapters);
  mock.module("../utils/sse", () => realSse);
});

async function fixture(withReply = true) {
  providers = [];
  providerCalls = 0;
  providerSignals = [];
  preparationGate = undefined;
  handlers.length = 0;
  const userId = crypto.randomUUID();
  const conversationId = crypto.randomUUID();
  const userMessageId = crypto.randomUUID();
  const assistantMessageId = crypto.randomUUID();
  const at = new Date(Date.now() - 60_000);
  await db.insert(users).values({
    id: userId,
    email: `${userId}@test.local`,
    username: "mutation",
    passwordHash: "x",
    createdAt: at,
    updatedAt: at,
  });
  await db.insert(conversations).values({
    id: conversationId,
    userId,
    title: "mutation ownership",
    defaultMode: "chat",
    lastMode: "chat",
    forceWebSearch: false,
    createdAt: at,
    updatedAt: at,
  });
  await db.insert(messages).values({
    id: userMessageId,
    conversationId,
    role: "user",
    content: "original question",
    mode: "chat",
    createdAt: at,
  });
  if (withReply)
    await db.insert(messages).values({
      id: assistantMessageId,
      conversationId,
      role: "assistant",
      content: "original answer",
      mode: "chat",
      createdAt: new Date(at.getTime() + 1000),
    });
  return {
    userId,
    conversationId,
    userMessageId,
    assistantMessageId,
    async close() {
      preparationGate?.release();
      for (const current of providers) current.gate?.release();
      await Promise.all(handlers);
      await client.execute({
        sql: "DELETE FROM messages_fts WHERE conversation_id = ?",
        args: [conversationId],
      });
      await db.delete(messages).where(eq(messages.conversationId, conversationId));
      await db.delete(conversations).where(eq(conversations.id, conversationId));
      await db.delete(users).where(eq(users.id, userId));
    },
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function reply(f: Fixture) {
  return (await db.select().from(messages).where(eq(messages.id, f.assistantMessageId)))[0];
}
async function run(f: Fixture, operation: "retry" | "edit") {
  return operation === "retry"
    ? regenerateMessage(f.userId, f.assistantMessageId)
    : editUserMessage(f.userId, f.userMessageId, "latest edited question");
}
async function expectLatest(f: Fixture, expected: string) {
  expect((await reply(f))?.content).toBe(expected);
  expect((await reply(f))?.finishReason).toBe(null);
  const indexed = await client.execute({
    sql: "SELECT content FROM messages_fts WHERE message_id = ?",
    args: [f.assistantMessageId],
  });
  expect(indexed.rows.map((row) => row.content)).toEqual([expected]);
}

for (const [older, newer] of [
  ["retry", "retry"],
  ["retry", "edit"],
  ["edit", "retry"],
] as const) {
  test(`late ${older} completion cannot overwrite a newer ${newer}`, async () => {
    const f = await fixture();
    const pending = gate();
    providers = [{ text: "old reply", gate: pending }, { text: "new reply" }];
    let reading: Promise<string> | undefined;
    try {
      reading = new Response(await run(f, older)).text();
      await pending.begun;
      await new Response(await run(f, newer)).text();
      await expectLatest(f, "new reply");
      pending.release();
      await reading;
      await expectLatest(f, "new reply");
    } finally {
      pending.release();
      await reading;
      await f.close();
    }
  });
}

test("a stopped retry's delayed partial save cannot overwrite its newer retry", async () => {
  const f = await fixture();
  const pending = gate();
  providers = [{ text: "stopped old reply", gate: pending }, { text: "new reply" }];
  try {
    const stream = await run(f, "retry");
    const finished = handlers.at(-1);
    const reader = stream.getReader();
    await pending.begun;
    await reader.cancel();
    await new Response(await run(f, "retry")).text();
    pending.release();
    await finished;
    await expectLatest(f, "new reply");
  } finally {
    pending.release();
    await f.close();
  }
});

for (const huge of [false, true]) {
  test(`delayed edit preparation cannot reclaim a newer retry${huge ? " on budget failure" : ""}`, async () => {
    const f = await fixture();
    const pending = gate();
    preparationGate = pending;
    providers = [{ text: "new reply" }];
    let old: Promise<ReadableStream> | undefined;
    try {
      old = editUserMessage(
        f.userId,
        f.userMessageId,
        huge ? "oversized ".repeat(40_000) : "old edited question",
      );
      await pending.begun;
      await new Response(await run(f, "retry")).text();
      pending.release();
      await new Response(await old).text();
      await expectLatest(f, "new reply");
      const [question] = await db.select().from(messages).where(eq(messages.id, f.userMessageId));
      expect(question?.content).toBe("original question");
      expect(providerCalls).toBe(1);
    } finally {
      pending.release();
      if (old) await old;
      await f.close();
    }
  });
}

test("deleting an edited tail question during preparation creates no reply or provider request", async () => {
  const f = await fixture(false);
  const pending = gate();
  preparationGate = pending;
  let old: Promise<ReadableStream> | undefined;
  try {
    old = editUserMessage(f.userId, f.userMessageId, "edited tail");
    await pending.begun;
    await deleteMessage(f.userId, f.userMessageId);
    pending.release();
    await new Response(await old).text();
    expect(providerCalls).toBe(0);
    expect(
      await db.select().from(messages).where(eq(messages.conversationId, f.conversationId)),
    ).toHaveLength(0);
  } finally {
    pending.release();
    if (old) await old;
    await f.close();
  }
});

test("deleting an edited tail question removes its pending reserved reply", async () => {
  const f = await fixture(false);
  const pending = gate();
  providers = [{ text: "old tail reply", gate: pending }];
  let reading: Promise<string> | undefined;
  try {
    reading = new Response(await editUserMessage(f.userId, f.userMessageId, "edited tail")).text();
    await pending.begun;
    await deleteMessage(f.userId, f.userMessageId);
    pending.release();
    await reading;
    expect(
      await db.select().from(messages).where(eq(messages.conversationId, f.conversationId)),
    ).toHaveLength(0);
    const indexed = await client.execute({
      sql: "SELECT content FROM messages_fts WHERE conversation_id = ?",
      args: [f.conversationId],
    });
    expect(indexed.rows).toHaveLength(0);
  } finally {
    pending.release();
    await reading;
    await f.close();
  }
});

test("an unauthorized retry cannot cancel another user's active reply", async () => {
  const f = await fixture();
  const pending = gate();
  providers = [{ text: "authorized reply", gate: pending }];
  let reading: Promise<string> | undefined;
  try {
    reading = new Response(await run(f, "retry")).text();
    await pending.begun;
    let rejected = false;
    try {
      await regenerateMessage(crypto.randomUUID(), f.assistantMessageId);
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(true);
    pending.release();
    await reading;
    await expectLatest(f, "authorized reply");
  } finally {
    pending.release();
    await reading;
    await f.close();
  }
});

test("deleting an active retry's reply cannot recreate its row or search entry", async () => {
  const f = await fixture();
  const pending = gate();
  providers = [{ text: "deleted reply", gate: pending }];
  let reading: Promise<string> | undefined;
  try {
    reading = new Response(await run(f, "retry")).text();
    await pending.begun;
    await deleteMessage(f.userId, f.assistantMessageId);
    pending.release();
    await reading;
    expect(await reply(f)).toBe(undefined);
    const indexed = await client.execute({
      sql: "SELECT content FROM messages_fts WHERE message_id = ?",
      args: [f.assistantMessageId],
    });
    expect(indexed.rows).toHaveLength(0);
    expect(await db.select().from(messages).where(eq(messages.id, f.userMessageId))).toHaveLength(
      1,
    );
  } finally {
    pending.release();
    await reading;
    await f.close();
  }
});

test("deleting a tail question preserves its reserved row after it becomes an Agent reply", async () => {
  const f = await fixture(false);
  const pending = gate();
  providers = [{ text: "obsolete Chat reply", gate: pending }];
  let reading: Promise<string> | undefined;
  try {
    reading = new Response(await editUserMessage(f.userId, f.userMessageId, "edited tail")).text();
    await pending.begun;
    const [reserved] = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, f.conversationId))
      .then((rows) => rows.filter((row) => row.role === "assistant"));
    expect(Boolean(reserved)).toBe(true);
    const run = {
      status: "completed",
      summary: "Tool-only Agent result",
      steps: [{ type: "tool_start", toolName: "Read", timestamp: Date.now() }],
    };
    await syncSidecarMessages(f.userId, {
      conversationId: f.conversationId,
      userMessageId: f.userMessageId,
      assistantMessageId: reserved.id,
      userContent: "Agent question",
      assistantContent: "",
      agentRun: run,
    });
    await deleteMessage(f.userId, f.userMessageId);
    pending.release();
    await reading;
    const [saved] = await db.select().from(messages).where(eq(messages.id, reserved.id));
    expect(saved?.mode).toBe("agent");
    expect(saved?.content).toBe("");
    expect(JSON.parse(saved?.agentRun ?? "null")).toEqual(run);
  } finally {
    pending.release();
    await reading;
    await f.close();
  }
});

test("a committed conversation deletion aborts its retry and suppresses late deltas", async () => {
  const f = await fixture();
  const pending = gate();
  providers = [{ text: "initial partial", gate: pending, tail: "forbidden late delta" }];
  let reading: Promise<string> | undefined;
  try {
    reading = new Response(await run(f, "retry")).text();
    await pending.begun;
    await deleteConversation(f.userId, f.conversationId);
    expect(providerSignals[0]?.aborted).toBe(true);
    pending.release();
    const raw = await reading;
    expect(raw.includes("forbidden late delta")).toBe(false);
    expect(
      await db.select().from(messages).where(eq(messages.conversationId, f.conversationId)),
    ).toHaveLength(0);
    expect(
      await db.select().from(conversations).where(eq(conversations.id, f.conversationId)),
    ).toHaveLength(0);
  } finally {
    pending.release();
    await reading;
    await f.close();
  }
});

test("a rolled-back conversation deletion does not abort its valid retry", async () => {
  const f = await fixture();
  const pending = gate();
  providers = [{ text: "surviving reply", gate: pending }];
  const trigger = `mutation_delete_${f.conversationId.replaceAll("-", "")}`;
  let reading: Promise<string> | undefined;
  try {
    reading = new Response(await run(f, "retry")).text();
    await pending.begun;
    await client.execute(
      `CREATE TRIGGER ${trigger} BEFORE DELETE ON conversations WHEN OLD.id = '${f.conversationId}' BEGIN SELECT RAISE(ABORT, 'synthetic deletion rollback'); END`,
    );
    let rejected = false;
    try {
      await deleteConversation(f.userId, f.conversationId);
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(true);
    expect(providerSignals[0]?.aborted).toBe(false);
    await client.execute(`DROP TRIGGER ${trigger}`);
    pending.release();
    await reading;
    await expectLatest(f, "surviving reply");
  } finally {
    await client.execute(`DROP TRIGGER IF EXISTS ${trigger}`);
    pending.release();
    await reading;
    await f.close();
  }
});
