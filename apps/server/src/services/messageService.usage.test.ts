import { expect, test } from "bun:test";
import { conversations, messages, users } from "db";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { syncSidecarMessages } from "./messageService";

/**
 * Agent answers persist through syncSidecarMessages, which used to drop token
 * counts entirely — the `usage` column was written only on the chat path, so
 * every agent row stored null and the bubble could never show a token line.
 */

async function seed(userId: string, conversationId: string, createdAt: Date) {
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
    title: "usage",
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
}

async function cleanup(userId: string, conversationId: string) {
  await db.delete(messages).where(eq(messages.conversationId, conversationId));
  await db.delete(conversations).where(eq(conversations.id, conversationId));
  await db.delete(users).where(eq(users.id, userId));
}

test("a freshly inserted agent round stores the token counts", async () => {
  const userId = crypto.randomUUID();
  const conversationId = crypto.randomUUID();
  const createdAt = new Date();

  try {
    await seed(userId, conversationId, createdAt);

    const { assistantMessageId } = await syncSidecarMessages(userId, {
      conversationId,
      userContent: "question",
      assistantContent: "answer",
      usage: { promptTokens: 47120, completionTokens: 800, totalTokens: 47920 },
    });

    const [row] = await db.select().from(messages).where(eq(messages.id, assistantMessageId));
    expect(JSON.parse(row?.usage ?? "null")).toEqual({
      promptTokens: 47120,
      completionTokens: 800,
      totalTokens: 47920,
    });
  } finally {
    await cleanup(userId, conversationId);
  }
});

test("a run that reported nothing stores null, not zeros", async () => {
  // "Not reported" has to stay distinguishable from "reported as zero": the
  // bubble hides the token line entirely for the former.
  const userId = crypto.randomUUID();
  const conversationId = crypto.randomUUID();
  const createdAt = new Date();

  try {
    await seed(userId, conversationId, createdAt);

    const { assistantMessageId } = await syncSidecarMessages(userId, {
      conversationId,
      userContent: "question",
      assistantContent: "answer",
    });

    const [row] = await db.select().from(messages).where(eq(messages.id, assistantMessageId));
    expect(row?.usage ?? null).toBe(null);
  } finally {
    await cleanup(userId, conversationId);
  }
});

test("regenerating in place replaces the previous turn's counts", async () => {
  // The counts belong to the run that produced the text. Leaving the old value
  // behind would attribute the first run's tokens to the second run's answer.
  const userId = crypto.randomUUID();
  const conversationId = crypto.randomUUID();
  const createdAt = new Date();

  try {
    await seed(userId, conversationId, createdAt);

    const first = await syncSidecarMessages(userId, {
      conversationId,
      userContent: "question",
      assistantContent: "first",
      usage: { promptTokens: 100, completionTokens: 10, totalTokens: 110 },
    });

    await syncSidecarMessages(userId, {
      conversationId,
      userContent: "question",
      assistantContent: "regenerated",
      userMessageId: first.userMessageId,
      assistantMessageId: first.assistantMessageId,
      usage: { promptTokens: 900, completionTokens: 90, totalTokens: 990 },
    });

    const [row] = await db.select().from(messages).where(eq(messages.id, first.assistantMessageId));
    expect(row?.content).toBe("regenerated");
    expect(JSON.parse(row?.usage ?? "null")).toEqual({
      promptTokens: 900,
      completionTokens: 90,
      totalTokens: 990,
    });
  } finally {
    await cleanup(userId, conversationId);
  }
});
