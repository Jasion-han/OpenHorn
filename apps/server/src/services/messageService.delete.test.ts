import { expect, test } from "bun:test";
import { attachments, conversations, messages, users } from "db";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { deleteMessage } from "./messageService";

test("deleteMessage clears linked attachments before deleting the message", async () => {
  const userId = crypto.randomUUID();
  const conversationId = crypto.randomUUID();
  const messageId = crypto.randomUUID();
  const attachmentId = crypto.randomUUID();
  const now = new Date();

  await db.insert(users).values({
    id: userId,
    email: `${userId}@test.local`,
    username: "u",
    passwordHash: "x",
    createdAt: now,
    updatedAt: now,
  });

  await db.insert(conversations).values({
    id: conversationId,
    userId,
    channelId: null,
    modelId: null,
    title: "conv",
    systemPrompt: null,
    contextLength: 4096,
    defaultMode: "agent",
    lastMode: "agent",
    isPinned: false,
    forceWebSearch: true,
    runStatus: null,
    workspaceId: null,
    createdAt: now,
    updatedAt: now,
  });

  await db.insert(messages).values({
    id: messageId,
    conversationId,
    role: "user",
    content: "hello",
    model: null,
    mode: "chat",
    attachments: JSON.stringify([attachmentId]),
    agentRun: null,
    workspaceId: null,
    contextPaths: null,
    liveMetadata: null,
    citations: null,
    createdAt: now,
  });

  await db.insert(attachments).values({
    id: attachmentId,
    conversationId,
    sessionId: null,
    messageId,
    fileName: "message.txt",
    filePath: "/tmp/message.txt",
    fileType: "text/plain",
    fileSize: 1,
    createdAt: now,
  });

  try {
    await deleteMessage(userId, messageId);

    const [messageRows, attachmentRows] = await Promise.all([
      db.select().from(messages).where(eq(messages.id, messageId)),
      db.select().from(attachments).where(eq(attachments.id, attachmentId)),
    ]);

    expect(messageRows).toHaveLength(0);
    expect(attachmentRows).toHaveLength(0);
  } finally {
    await db.delete(attachments).where(eq(attachments.id, attachmentId));
    await db.delete(messages).where(eq(messages.id, messageId));
    await db
      .delete(conversations)
      .where(and(eq(conversations.id, conversationId), eq(conversations.userId, userId)));
    await db.delete(users).where(eq(users.id, userId));
  }
});
