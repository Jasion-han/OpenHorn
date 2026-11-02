import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { conversations, messages, users } from "db";
import { eq } from "drizzle-orm";
import { client, db } from "../db";
import * as realChannelsNs from "./channelService";
import {
  completeChatFromSidecar,
  prepareChatForSidecar,
  syncSidecarMessages,
} from "./messageService";

const realChannels = { ...realChannelsNs };
beforeAll(() => {
  // Preparation resolves a channel but never calls a provider. Keep that
  // dependency synthetic while exercising real service writes and ordering.
  mock.module("./channelService", () => ({
    ...realChannels,
    getResolvedChannelForConversation: async () => ({
      channel: { id: "mode-fixture", protocol: "openai", baseUrl: null },
      apiKey: "synthetic-mode-fixture",
      modelId: "fixture-model",
    }),
  }));
});
afterAll(() => {
  mock.module("./channelService", () => realChannels);
});

async function seed() {
  const userId = crypto.randomUUID();
  const conversationId = crypto.randomUUID();
  const createdAt = new Date(Date.now() - 60_000);
  await db.insert(users).values({
    id: userId,
    email: `${userId}@test.local`,
    username: "sidecar-mode",
    passwordHash: "x",
    createdAt,
    updatedAt: createdAt,
  });
  await db.insert(conversations).values({
    id: conversationId,
    userId,
    title: "mode persistence",
    defaultMode: "chat",
    lastMode: "chat",
    createdAt,
    updatedAt: createdAt,
  });
  return { userId, conversationId, createdAt };
}

async function cleanup(fixture: Awaited<ReturnType<typeof seed>>) {
  await db.delete(messages).where(eq(messages.conversationId, fixture.conversationId));
  await db.delete(conversations).where(eq(conversations.id, fixture.conversationId));
  await db.delete(users).where(eq(users.id, fixture.userId));
}

async function readConversation(conversationId: string) {
  const [conversation] = await db
    .select()
    .from(conversations)
    .where(eq(conversations.id, conversationId));
  return conversation;
}

async function seedRound(
  fixture: Awaited<ReturnType<typeof seed>>,
  withReply: boolean,
  mode: "chat" | "agent" = "agent",
) {
  const userMessageId = crypto.randomUUID();
  const assistantMessageId = crypto.randomUUID();
  await db.insert(messages).values({
    id: userMessageId,
    conversationId: fixture.conversationId,
    role: "user",
    mode,
    content: "original question",
    createdAt: fixture.createdAt,
  });
  if (withReply) {
    await db.insert(messages).values({
      id: assistantMessageId,
      conversationId: fixture.conversationId,
      role: "assistant",
      mode,
      content: "original answer",
      createdAt: fixture.createdAt,
    });
  }
  return { userMessageId, ...(withReply ? { assistantMessageId } : {}) };
}

for (const branch of ["new", "user-only", "pair"] as const) {
  for (const outcome of ["completed", "failed", "stopped"] as const) {
    test(`sidecar ${branch} ${outcome} persists the latest mode and conversation activity`, async () => {
      const fixture = await seed();
      try {
        const ids = branch === "new" ? {} : await seedRound(fixture, branch === "pair");
        await syncSidecarMessages(fixture.userId, {
          conversationId: fixture.conversationId,
          userContent: "updated question",
          assistantContent: "",
          agentRun: {
            status: outcome === "stopped" ? "partial" : outcome,
            steps: [{ type: "text", content: "updated answer" }],
            ...(outcome === "failed" ? { error: "synthetic failure" } : {}),
          },
          ...(outcome === "stopped" ? { finishReason: "stopped" } : {}),
          ...ids,
        });

        const conversation = await readConversation(fixture.conversationId);
        expect(conversation.lastMode).toBe("agent");
        expect(conversation.defaultMode).toBe("chat");
        expect(conversation.updatedAt.getTime() > fixture.createdAt.getTime()).toBe(true);
        const rows = await db
          .select()
          .from(messages)
          .where(eq(messages.conversationId, fixture.conversationId));
        expect(rows).toHaveLength(2);
        expect(rows.find((row) => row.role === "assistant")?.content).toBe("updated answer");
      } finally {
        await cleanup(fixture);
      }
    });
  }
}

test("an explicit Chat sync preserves Chat as the last executed mode", async () => {
  const fixture = await seed();
  try {
    await db
      .update(conversations)
      .set({ lastMode: "agent" })
      .where(eq(conversations.id, fixture.conversationId));
    await syncSidecarMessages(fixture.userId, {
      conversationId: fixture.conversationId,
      userContent: "chat question",
      assistantContent: "chat answer",
      mode: "chat",
    });
    expect((await readConversation(fixture.conversationId)).lastMode).toBe("chat");
  } finally {
    await cleanup(fixture);
  }
});

for (const withReply of [false, true]) {
  test(`retrying an older Agent round preserves the later Chat mode (reply=${withReply})`, async () => {
    const fixture = await seed();
    try {
      const ids = await seedRound(fixture, withReply);
      // Equal SQLite-second timestamps must not confuse request order.
      await db.insert(messages).values({
        id: crypto.randomUUID(),
        conversationId: fixture.conversationId,
        role: "user",
        mode: "chat",
        content: "later chat question",
        createdAt: fixture.createdAt,
      });
      await syncSidecarMessages(fixture.userId, {
        conversationId: fixture.conversationId,
        userContent: "retried question",
        assistantContent: "retried answer",
        mode: "agent",
        ...ids,
      });
      const conversation = await readConversation(fixture.conversationId);
      expect(conversation.lastMode).toBe("chat");
      expect(conversation.updatedAt.getTime() > fixture.createdAt.getTime()).toBe(true);
    } finally {
      await cleanup(fixture);
    }
  });
}

test("a newer Chat inserted during Agent sync wins the atomic mode update", async () => {
  const fixture = await seed();
  const triggerName = `later_chat_${fixture.conversationId.replaceAll("-", "")}`;
  const laterUserId = crypto.randomUUID();
  try {
    // A real SQLite trigger deterministically interleaves a later Chat prepare
    // after the Agent rows are written but before its metadata update.
    await client.execute(`CREATE TRIGGER ${triggerName} AFTER INSERT ON messages
      WHEN NEW.conversation_id = '${fixture.conversationId}'
        AND NEW.role = 'assistant' AND NEW.mode = 'agent'
      BEGIN
        INSERT INTO messages (id, conversation_id, role, mode, content, created_at)
        VALUES ('${laterUserId}', NEW.conversation_id, 'user', 'chat',
          'later chat question', NEW.created_at);
        UPDATE conversations SET last_mode = 'chat' WHERE id = NEW.conversation_id;
      END`);
    await syncSidecarMessages(fixture.userId, {
      conversationId: fixture.conversationId,
      userContent: "agent question",
      assistantContent: "agent answer",
    });
    const conversation = await readConversation(fixture.conversationId);
    expect(conversation.lastMode).toBe("chat");
    expect(conversation.updatedAt.getTime() > fixture.createdAt.getTime()).toBe(true);
    const laterUser = await db.query.messages.findFirst({ where: eq(messages.id, laterUserId) });
    expect(laterUser?.mode).toBe("chat");
  } finally {
    await client.execute(`DROP TRIGGER IF EXISTS ${triggerName}`);
    await cleanup(fixture);
  }
});

test("a late Chat completion preserves the mode of a newer Agent request", async () => {
  const fixture = await seed();
  try {
    const oldChat = await seedRound(fixture, true, "chat");
    await syncSidecarMessages(fixture.userId, {
      conversationId: fixture.conversationId,
      userContent: "newer agent question",
      assistantContent: "newer agent answer",
    });
    expect((await readConversation(fixture.conversationId)).lastMode).toBe("agent");

    await completeChatFromSidecar(fixture.userId, {
      conversationId: fixture.conversationId,
      assistantMessageId: oldChat.assistantMessageId as string,
      content: "late chat answer",
    });
    expect((await readConversation(fixture.conversationId)).lastMode).toBe("agent");
    const reply = await db.query.messages.findFirst({
      where: eq(messages.id, oldChat.assistantMessageId as string),
    });
    expect(reply?.content).toBe("late chat answer");
  } finally {
    await cleanup(fixture);
  }
});

test("completion of the latest prepared Chat keeps its saved Chat mode", async () => {
  const fixture = await seed();
  try {
    await db
      .update(conversations)
      .set({ lastMode: "agent" })
      .where(eq(conversations.id, fixture.conversationId));
    const chat = await prepareChatForSidecar(fixture.userId, {
      conversationId: fixture.conversationId,
      content: "chat question",
    });
    expect((await readConversation(fixture.conversationId)).lastMode).toBe("chat");
    await completeChatFromSidecar(fixture.userId, {
      conversationId: fixture.conversationId,
      assistantMessageId: chat.assistantMessageId,
      content: "chat answer",
    });
    const conversation = await readConversation(fixture.conversationId);
    expect(conversation.lastMode).toBe("chat");
    expect(conversation.updatedAt.getTime() > fixture.createdAt.getTime()).toBe(true);
  } finally {
    await cleanup(fixture);
  }
});

test("Chat preparation preserves a newer Agent accepted between its user and assistant writes", async () => {
  const fixture = await seed();
  const triggerName = `later_agent_${fixture.conversationId.replaceAll("-", "")}`;
  const laterUserId = crypto.randomUUID();
  try {
    await client.execute(`CREATE TRIGGER ${triggerName} AFTER INSERT ON messages
      WHEN NEW.conversation_id = '${fixture.conversationId}'
        AND NEW.role = 'user' AND NEW.mode = 'chat'
      BEGIN
        INSERT INTO messages (id, conversation_id, role, mode, content, created_at)
        VALUES ('${laterUserId}', NEW.conversation_id, 'user', 'agent',
          'newer agent question', NEW.created_at);
        UPDATE conversations SET last_mode = 'agent' WHERE id = NEW.conversation_id;
      END`);
    const prepared = await prepareChatForSidecar(fixture.userId, {
      conversationId: fixture.conversationId,
      content: "chat question",
    });
    expect((await readConversation(fixture.conversationId)).lastMode).toBe("agent");
    const reply = await db.query.messages.findFirst({
      where: eq(messages.id, prepared.assistantMessageId),
    });
    expect(reply?.mode).toBe("chat");
  } finally {
    await client.execute(`DROP TRIGGER IF EXISTS ${triggerName}`);
    await cleanup(fixture);
  }
});

test("foreign conversation sync rejects before changing messages or conversation metadata", async () => {
  const fixture = await seed();
  try {
    const before = await readConversation(fixture.conversationId);
    let error: unknown;
    try {
      await syncSidecarMessages(crypto.randomUUID(), {
        conversationId: fixture.conversationId,
        userContent: "unauthorized question",
        assistantContent: "unauthorized answer",
      });
    } catch (caught) {
      error = caught;
    }
    expect(error instanceof Error && error.message).toBe("Conversation not found");
    expect(await readConversation(fixture.conversationId)).toEqual(before);
    const rows = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, fixture.conversationId));
    expect(rows).toHaveLength(0);
  } finally {
    await cleanup(fixture);
  }
});
