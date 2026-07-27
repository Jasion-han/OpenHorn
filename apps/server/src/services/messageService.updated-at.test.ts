import { expect, test } from "bun:test";
import { conversations, messages, users } from "db";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { syncSidecarMessages } from "./messageService";

/**
 * The bubble shows a timestamp only once an answer has finished, and shows the
 * regenerated time when it is produced again. Both rely on `updatedAt` being
 * stamped whenever an assistant answer is written into an existing row — and on
 * `createdAt` staying put, since the thread is ordered by it.
 */
test("re-persisting an assistant answer stamps updatedAt and leaves createdAt alone", async () => {
  const userId = crypto.randomUUID();
  const conversationId = crypto.randomUUID();
  const userMessageId = crypto.randomUUID();
  const assistantMessageId = crypto.randomUUID();
  const createdAt = new Date(Date.now() - 60_000);

  try {
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
      channelId: null,
      modelId: null,
      title: "updated-at",
      systemPrompt: null,
      contextLength: 4096,
      defaultMode: "agent",
      lastMode: "agent",
      isPinned: false,
      forceWebSearch: true,
      runStatus: null,
      workspaceId: null,
      createdAt,
      updatedAt: createdAt,
    });
    for (const [id, role, content] of [
      [userMessageId, "user", "question"],
      [assistantMessageId, "assistant", "first answer"],
    ] as const) {
      await db.insert(messages).values({
        id,
        conversationId,
        role,
        content,
        model: null,
        mode: "agent",
        attachments: null,
        agentRun: null,
        createdAt,
      });
    }

    const [before] = await db.select().from(messages).where(eq(messages.id, assistantMessageId));
    expect(before?.updatedAt ?? null).toBe(null);

    await syncSidecarMessages(userId, {
      conversationId,
      userContent: "question",
      assistantContent: "regenerated answer",
      userMessageId,
      assistantMessageId,
    });

    const [after] = await db.select().from(messages).where(eq(messages.id, assistantMessageId));
    expect(after?.content).toBe("regenerated answer");
    // Timestamps round-trip through SQLite at second resolution.
    const seconds = (value?: Date | null) => Math.floor((value?.getTime() ?? 0) / 1000);
    expect(seconds(after?.createdAt)).toBe(seconds(createdAt));
    expect(seconds(after?.updatedAt) > seconds(createdAt)).toBe(true);
  } finally {
    await db.delete(messages).where(eq(messages.conversationId, conversationId));
    await db.delete(conversations).where(eq(conversations.id, conversationId));
    await db.delete(users).where(eq(users.id, userId));
  }
});
