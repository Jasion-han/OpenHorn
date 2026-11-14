import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import type { ChatUsage } from "adapters";
import { conversations, messages, users } from "db";
import { eq } from "drizzle-orm";
import * as adaptersNamespace from "../agent-adapters";
import { client, db } from "../db";
import * as channelsNamespace from "./channelService";
import {
  completeChatFromSidecar,
  editUserMessage,
  prepareChatForSidecar,
  regenerateMessage,
  searchMessages,
  sendMessage,
  streamMessage,
  syncSidecarMessages,
} from "./messageService";

const realAdapters = { ...adaptersNamespace };
const realChannels = { ...channelsNamespace };
type Provider = {
  usage?: ChatUsage;
  gate?: Promise<void>;
  started?: () => void;
  failure?: boolean;
};
let provider: Provider = {};

beforeAll(() => {
  mock.module("./channelService", () => ({
    ...realChannels,
    getResolvedChannelForConversation: async () => ({
      channel: { id: "lifecycle-fixture", protocol: "openai", baseUrl: null },
      apiKey: "synthetic-lifecycle-key",
      modelId: "fixture-model",
    }),
  }));
  mock.module("../agent-adapters", () => ({
    ...realAdapters,
    createAdapter: () => ({
      chatStream: async function* (input: { signal?: AbortSignal }) {
        const current = provider;
        yield "fixture answer";
        current.started?.();
        if (current.gate) {
          await Promise.race([
            current.gate,
            new Promise<void>((resolve) => {
              if (input.signal?.aborted) resolve();
              else input.signal?.addEventListener("abort", () => resolve(), { once: true });
            }),
          ]);
        }
        if (input.signal?.aborted) throw new DOMException("Stopped", "AbortError");
        if (current.failure) throw new Error("synthetic provider failure");
        return current.usage;
      },
    }),
  }));
});

afterAll(() => {
  mock.module("./channelService", () => realChannels);
  mock.module("../agent-adapters", () => realAdapters);
});

async function fixture(existingUserId?: string) {
  provider = {};
  const userId = existingUserId ?? crypto.randomUUID();
  const conversationId = crypto.randomUUID();
  const userMessageId = crypto.randomUUID();
  const assistantMessageId = crypto.randomUUID();
  const at = new Date(Date.now() - 60_000);
  if (!existingUserId)
    await db.insert(users).values({
      id: userId,
      email: `${userId}@test.local`,
      username: "lifecycle",
      passwordHash: "x",
      createdAt: at,
      updatedAt: at,
    });
  await db.insert(conversations).values({
    id: conversationId,
    userId,
    title: "lifecycle",
    defaultMode: "chat",
    lastMode: "chat",
    forceWebSearch: false,
    createdAt: at,
    updatedAt: at,
  });
  for (const [id, role] of [
    [userMessageId, "user"],
    [assistantMessageId, "assistant"],
  ] as const)
    await db.insert(messages).values({
      id,
      conversationId,
      role,
      content: role === "user" ? "fixture question" : "initial answer",
      mode: "chat",
      createdAt: at,
    });
  return {
    userId,
    conversationId,
    userMessageId,
    assistantMessageId,
    async close() {
      await client.execute({
        sql: "DELETE FROM messages_fts WHERE conversation_id = ?",
        args: [conversationId],
      });
      await db.delete(messages).where(eq(messages.conversationId, conversationId));
      await db.delete(conversations).where(eq(conversations.id, conversationId));
      if (!existingUserId) await db.delete(users).where(eq(users.id, userId));
    },
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
async function complete(f: Fixture, content: string, assistantMessageId = f.assistantMessageId) {
  return completeChatFromSidecar(f.userId, {
    conversationId: f.conversationId,
    assistantMessageId,
    content,
  });
}
async function indexRows(id: string) {
  return (
    await client.execute({
      sql: "SELECT message_id, conversation_id, content FROM messages_fts WHERE message_id = ?",
      args: [id],
    })
  ).rows;
}

for (const replacement of ["retry", "edit"] as const) {
  test(`a delayed prepared completion cannot overwrite a newer ${replacement}`, async () => {
    const f = await fixture();
    try {
      const prepared = await prepareChatForSidecar(f.userId, {
        conversationId: f.conversationId,
        content: "prepared question",
      });
      expect(typeof prepared.saveToken).toBe("string");
      const stream =
        replacement === "retry"
          ? await regenerateMessage(f.userId, prepared.assistantMessageId)
          : await editUserMessage(f.userId, prepared.userMessageId, "edited question");
      await new Response(stream).text();
      await expect(
        completeChatFromSidecar(f.userId, {
          conversationId: f.conversationId,
          assistantMessageId: prepared.assistantMessageId,
          saveToken: prepared.saveToken,
          content: "stale stopped answer",
          finishReason: "stopped",
        }),
      ).rejects.toThrow("saved message changed");
      const [row] = await db
        .select()
        .from(messages)
        .where(eq(messages.id, prepared.assistantMessageId));
      expect(row.content).toBe("fixture answer");
      expect(row.finishReason).toBe(null);
      expect((await indexRows(prepared.assistantMessageId))[0]?.content).toBe("fixture answer");
    } finally {
      await f.close();
    }
  });
}

for (const failure of [false, true]) {
  test(`older SSE Chat ${failure ? "failure" : "completion"} preserves a newer Agent request mode`, async () => {
    const f = await fixture();
    let release = () => {};
    let started = () => {};
    const begun = new Promise<void>((resolve) => {
      started = resolve;
    });
    provider = {
      failure,
      started,
      gate: new Promise<void>((resolve) => {
        release = resolve;
      }),
    };
    try {
      const reading = new Response(
        await streamMessage(f.userId, {
          conversationId: f.conversationId,
          content: "older chat request",
          mode: "chat",
        }),
      ).text();
      await begun;
      await syncSidecarMessages(f.userId, {
        conversationId: f.conversationId,
        userContent: "newer Agent request",
        assistantContent: "newer Agent answer",
        agentRun: { status: "completed", steps: [{ type: "text", content: "Agent answer" }] },
      });
      release();
      const raw = await reading;
      expect(raw.includes("fixture answer")).toBe(true);
      const [conversation] = await db
        .select()
        .from(conversations)
        .where(eq(conversations.id, f.conversationId));
      expect(conversation?.lastMode).toBe("agent");
      const saved = await db
        .select()
        .from(messages)
        .where(eq(messages.conversationId, f.conversationId));
      expect(saved.some((row) => row.content === "fixture answer")).toBe(true);
    } finally {
      release();
      await f.close();
    }
  });
}

test("SSE Chat request-start mode update respects a newer inserted user even at equal timestamps", async () => {
  const f = await fixture();
  const trigger = `newer_request_${crypto.randomUUID().replaceAll("-", "")}`;
  const laterUserId = crypto.randomUUID();
  try {
    await client.execute(`CREATE TRIGGER ${trigger} AFTER INSERT ON messages
      WHEN NEW.conversation_id = '${f.conversationId}' AND NEW.role = 'user'
        AND NEW.content = 'older chat request'
      BEGIN
        INSERT INTO messages (id, conversation_id, role, content, mode, created_at)
        VALUES ('${laterUserId}', NEW.conversation_id, 'user', 'newer Agent request', 'agent', NEW.created_at);
        UPDATE conversations SET last_mode = 'agent' WHERE id = NEW.conversation_id;
      END`);
    await new Response(
      await streamMessage(f.userId, {
        conversationId: f.conversationId,
        content: "older chat request",
        mode: "chat",
      }),
    ).text();
    const [conversation] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, f.conversationId));
    expect(conversation?.lastMode).toBe("agent");
  } finally {
    await client.execute(`DROP TRIGGER IF EXISTS ${trigger}`);
    await f.close();
  }
});

test("empty sidecar replacement removes old full-text matches while retaining the empty reply", async () => {
  const f = await fixture();
  try {
    await complete(f, "uniquelifecyclemarker");
    expect(await searchMessages(f.userId, "uniquelifecyclemarker")).toHaveLength(1);
    await complete(f, "");
    const [row] = await db.select().from(messages).where(eq(messages.id, f.assistantMessageId));
    expect(row?.content).toBe("");
    expect(await indexRows(f.assistantMessageId)).toHaveLength(0);
    expect(await searchMessages(f.userId, "uniquelifecyclemarker")).toHaveLength(0);
  } finally {
    await f.close();
  }
});

for (const kind of ["foreign", "same-owner", "user-role", "missing"] as const) {
  test(`sidecar completion rejects ${kind} identity without changing primary or search records`, async () => {
    const f = await fixture();
    const other = await fixture(kind === "same-owner" ? f.userId : undefined);
    try {
      await complete(f, "ownerindexmarker");
      await complete(other, "otherindexmarker");
      const targetId =
        kind === "user-role"
          ? f.userMessageId
          : kind === "missing"
            ? crypto.randomUUID()
            : other.assistantMessageId;
      const before = await db.select().from(messages).where(eq(messages.id, targetId));
      const beforeIndex = await indexRows(targetId);
      await expect(complete(f, "forged replacement", targetId)).rejects.toThrow("Assistant");
      expect(await db.select().from(messages).where(eq(messages.id, targetId))).toEqual(before);
      expect(await indexRows(targetId)).toEqual(beforeIndex);
      expect(await searchMessages(other.userId, "otherindexmarker")).toHaveLength(1);
    } finally {
      await other.close();
      await f.close();
    }
  });
}

test("search ignores mismatched index and message conversation identities", async () => {
  const f = await fixture();
  const other = await fixture();
  try {
    await client.execute({
      sql: "INSERT INTO messages_fts(message_id, conversation_id, content) VALUES (?, ?, ?)",
      args: [other.assistantMessageId, f.conversationId, "mismatchedindexmarker"],
    });
    expect(await searchMessages(f.userId, "mismatchedindexmarker")).toHaveLength(0);
  } finally {
    await other.close();
    await f.close();
  }
});

for (const usage of [
  { promptTokens: 11, completionTokens: 7, totalTokens: 18 },
  { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  undefined,
]) {
  test(`non-streaming Chat preserves ${usage === undefined ? "unreported" : usage.totalTokens === 0 ? "reported zero" : "reported"} token usage`, async () => {
    const f = await fixture();
    provider = { usage };
    try {
      const result = await sendMessage(f.userId, {
        conversationId: f.conversationId,
        content: "usage question",
        mode: "chat",
      });
      const [row] = await db
        .select()
        .from(messages)
        .where(eq(messages.id, result.assistantMessage.id));
      expect(JSON.parse(row?.usage ?? "null")).toEqual(usage ?? null);
      expect((result.assistantMessage as { usage?: ChatUsage }).usage).toEqual(usage);
      expect(row?.content).toBe("fixture answer");
    } finally {
      await f.close();
    }
  });
}

for (const newerRequest of [false, true]) {
  test(`non-streaming Chat saves its mode ${newerRequest ? "without overwriting a newer request" : "when the prior mode was Agent"}`, async () => {
    const f = await fixture();
    const trigger = `newer_send_${crypto.randomUUID().replaceAll("-", "")}`;
    try {
      await db
        .update(conversations)
        .set({ lastMode: "agent" })
        .where(eq(conversations.id, f.conversationId));
      if (newerRequest)
        await client.execute(`CREATE TRIGGER ${trigger} AFTER INSERT ON messages
          WHEN NEW.conversation_id = '${f.conversationId}' AND NEW.role = 'user'
            AND NEW.content = 'mode request'
          BEGIN
            INSERT INTO messages (id, conversation_id, role, content, mode, created_at)
            VALUES ('${crypto.randomUUID()}', NEW.conversation_id, 'user', 'newer Agent request', 'agent', NEW.created_at);
          END`);
      await sendMessage(f.userId, {
        conversationId: f.conversationId,
        content: "mode request",
        mode: "chat",
      });
      const [row] = await db
        .select()
        .from(conversations)
        .where(eq(conversations.id, f.conversationId));
      expect(row?.lastMode).toBe(newerRequest ? "agent" : "chat");
    } finally {
      await client.execute(`DROP TRIGGER IF EXISTS ${trigger}`);
      await f.close();
    }
  });
}

for (const kind of ["agent-mode", "agent-run", "legacy-chat"] as const) {
  test(`sidecar Chat completion ${kind === "legacy-chat" ? "accepts" : "rejects"} ${kind} assistant rows`, async () => {
    const f = await fixture();
    try {
      await complete(f, "originalkindmarker");
      await db
        .update(messages)
        .set({
          mode: kind === "agent-mode" ? "agent" : kind === "legacy-chat" ? null : "chat",
          agentRun:
            kind === "agent-run"
              ? JSON.stringify({
                  status: "completed",
                  steps: [{ type: "text", content: "originalkindmarker" }],
                })
              : null,
        })
        .where(eq(messages.id, f.assistantMessageId));
      const before = await db.select().from(messages).where(eq(messages.id, f.assistantMessageId));
      const beforeIndex = await indexRows(f.assistantMessageId);
      if (kind === "legacy-chat") {
        await complete(f, "legacy replacement");
        const [row] = await db.select().from(messages).where(eq(messages.id, f.assistantMessageId));
        expect(row?.content).toBe("legacy replacement");
      } else {
        await expect(complete(f, "invalid Chat overwrite")).rejects.toThrow("Assistant");
        expect(
          await db.select().from(messages).where(eq(messages.id, f.assistantMessageId)),
        ).toEqual(before);
        expect(await indexRows(f.assistantMessageId)).toEqual(beforeIndex);
      }
    } finally {
      await f.close();
    }
  });
}
