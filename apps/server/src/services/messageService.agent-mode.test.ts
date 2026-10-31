import { expect, test } from "bun:test";
import { conversations, messages, users } from "db";
import { asc, eq } from "drizzle-orm";
import { client, db } from "../db";
import {
  AgentModeUnsupportedError,
  editUserMessage,
  regenerateMessage,
  sendMessage,
  streamMessage,
  syncSidecarMessages,
} from "./messageService";

/**
 * Agent turns run only in the desktop sidecar. The server used to plan a
 * "task-backed" turn that nothing could execute any more, leaving a reply that
 * never arrived. Every server entry point must now refuse an agent turn up
 * front — before any row is written.
 */

async function seed(userId: string, conversationId: string) {
  const createdAt = new Date();
  await db.insert(users).values({
    id: userId,
    email: `${userId}@test.local`,
    username: "u",
    passwordHash: "x",
    createdAt,
    updatedAt: createdAt,
  });
  await db.insert(conversations).values({
    id: conversationId,
    userId,
    title: "agent mode",
    contextLength: 4096,
    defaultMode: "agent",
    lastMode: "agent",
    isPinned: false,
    forceWebSearch: false,
    createdAt,
    updatedAt: createdAt,
  });
}

async function cleanup(userId: string, conversationId: string) {
  await client.execute({ sql: "DELETE FROM agent_tasks WHERE user_id = ?", args: [userId] });
  await db.delete(messages).where(eq(messages.conversationId, conversationId));
  await db.delete(conversations).where(eq(conversations.id, conversationId));
  await db.delete(users).where(eq(users.id, userId));
}

async function rowsOf(conversationId: string) {
  return db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(asc(messages.createdAt));
}

async function taskCount(userId: string) {
  const result = await client.execute({
    sql: "SELECT COUNT(*) AS n FROM agent_tasks WHERE user_id = ?",
    args: [userId],
  });
  return Number(result.rows[0]?.n ?? 0);
}

async function rejection(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return null;
}

/** A user + agent assistant round, the assistant one second after the user. */
async function seedAgentRound(conversationId: string, withReply: boolean) {
  const at = Date.now();
  const userMessageId = crypto.randomUUID();
  const assistantMessageId = crypto.randomUUID();
  await db.insert(messages).values({
    id: userMessageId,
    conversationId,
    role: "user",
    content: "question",
    mode: "agent",
    createdAt: new Date(at),
  });
  if (withReply) {
    await db.insert(messages).values({
      id: assistantMessageId,
      conversationId,
      role: "assistant",
      content: "answer",
      mode: "agent",
      agentRun: JSON.stringify({
        status: "completed",
        steps: [{ type: "text", content: "answer" }],
      }),
      createdAt: new Date(at + 1000),
    });
  }
  return { userMessageId, assistantMessageId };
}

test("streamMessage refuses agent mode (explicit or omitted) before writing anything", async () => {
  const userId = crypto.randomUUID();
  const conversationId = crypto.randomUUID();
  try {
    await seed(userId, conversationId);
    for (const mode of ["agent", undefined] as const) {
      const error = await rejection(
        streamMessage(userId, { conversationId, content: "do a thing", mode }),
      );
      expect(error instanceof AgentModeUnsupportedError).toBe(true);
      expect((error as AgentModeUnsupportedError).code).toBe("agent_mode_unsupported");
    }
    expect(await rowsOf(conversationId)).toHaveLength(0);
    expect(await taskCount(userId)).toBe(0);
  } finally {
    await cleanup(userId, conversationId);
  }
});

test("sendMessage refuses agent mode before writing anything", async () => {
  const userId = crypto.randomUUID();
  const conversationId = crypto.randomUUID();
  try {
    await seed(userId, conversationId);
    const error = await rejection(
      sendMessage(userId, { conversationId, content: "do a thing", mode: "agent" }),
    );
    expect(error instanceof AgentModeUnsupportedError).toBe(true);
    expect(await rowsOf(conversationId)).toHaveLength(0);
  } finally {
    await cleanup(userId, conversationId);
  }
});

test("regenerating an agent reply is refused and leaves the round untouched", async () => {
  const userId = crypto.randomUUID();
  const conversationId = crypto.randomUUID();
  try {
    await seed(userId, conversationId);
    const { assistantMessageId } = await seedAgentRound(conversationId, true);
    const before = await rowsOf(conversationId);

    const error = await rejection(regenerateMessage(userId, assistantMessageId));
    expect(error instanceof AgentModeUnsupportedError).toBe(true);
    expect(await rowsOf(conversationId)).toEqual(before);
    expect(await taskCount(userId)).toBe(0);
  } finally {
    await cleanup(userId, conversationId);
  }
});

test("regenerate of someone else's agent reply reports the conversation, not the mode", async () => {
  const ownerId = crypto.randomUUID();
  const conversationId = crypto.randomUUID();
  try {
    await seed(ownerId, conversationId);
    const { assistantMessageId } = await seedAgentRound(conversationId, true);
    const error = await rejection(regenerateMessage(crypto.randomUUID(), assistantMessageId));
    expect(error instanceof AgentModeUnsupportedError).toBe(false);
    expect((error as Error).message).toBe("Conversation not found");
  } finally {
    await cleanup(ownerId, conversationId);
  }
});

test("editing an agent round is refused, with or without a reply after it", async () => {
  const userId = crypto.randomUUID();
  const conversationId = crypto.randomUUID();
  const tailConversationId = crypto.randomUUID();
  try {
    await seed(userId, conversationId);
    await db.insert(conversations).values({
      id: tailConversationId,
      userId,
      title: "tail",
      contextLength: 4096,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const round = await seedAgentRound(conversationId, true);
    const tail = await seedAgentRound(tailConversationId, false);

    for (const [id, convId] of [
      [round.userMessageId, conversationId],
      [tail.userMessageId, tailConversationId],
    ] as const) {
      const before = await rowsOf(convId);
      const error = await rejection(editUserMessage(userId, id, "new question"));
      expect(error instanceof AgentModeUnsupportedError).toBe(true);
      expect(await rowsOf(convId)).toEqual(before);
    }
    // The regenerate fallback (assistant id unknown) routes through edit too.
    const error = await rejection(
      regenerateMessage(userId, crypto.randomUUID(), {
        fallbackUserMessageId: tail.userMessageId,
        fallbackUserContent: "new question",
      }),
    );
    expect(error instanceof AgentModeUnsupportedError).toBe(true);
    expect(await taskCount(userId)).toBe(0);
  } finally {
    await db.delete(messages).where(eq(messages.conversationId, tailConversationId));
    await db.delete(conversations).where(eq(conversations.id, tailConversationId));
    await cleanup(userId, conversationId);
  }
});

test("sidecar sync with only the user id updates it in place and inserts the reply", async () => {
  const userId = crypto.randomUUID();
  const conversationId = crypto.randomUUID();
  try {
    await seed(userId, conversationId);
    const { userMessageId } = await seedAgentRound(conversationId, false);

    const result = await syncSidecarMessages(userId, {
      conversationId,
      userContent: "edited question",
      assistantContent: "",
      mode: "agent",
      agentRun: { status: "completed", steps: [{ type: "text", content: "the answer" }] },
      userMessageId,
    });

    expect(result.userMessageId).toBe(userMessageId);
    const rows = await rowsOf(conversationId);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ id: userMessageId, role: "user", content: "edited question" });
    expect(rows[1]).toMatchObject({
      id: result.assistantMessageId,
      role: "assistant",
      content: "the answer",
    });
  } finally {
    await cleanup(userId, conversationId);
  }
});
