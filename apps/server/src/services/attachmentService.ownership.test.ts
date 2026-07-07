import { expect, test } from "bun:test";
import { agentSessions, attachments, conversations, messages, users } from "db";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { getAttachmentsByIds, linkAttachmentsToMessage } from "./attachmentService";

async function seedUser(now: Date) {
  const userId = crypto.randomUUID();
  await db.insert(users).values({
    id: userId,
    email: `${userId}@test.local`,
    username: "u",
    passwordHash: "x",
    createdAt: now,
    updatedAt: now,
  });
  return userId;
}

async function seedConversation(userId: string, now: Date) {
  const conversationId = crypto.randomUUID();
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
    forceWebSearch: false,
    runStatus: null,
    workspaceId: null,
    createdAt: now,
    updatedAt: now,
  });
  return conversationId;
}

async function seedConversationAttachment(conversationId: string, now: Date) {
  const attachmentId = crypto.randomUUID();
  await db.insert(attachments).values({
    id: attachmentId,
    conversationId,
    sessionId: null,
    messageId: null,
    fileName: "file.txt",
    filePath: "/tmp/file.txt",
    fileType: "text/plain",
    fileSize: 1,
    createdAt: now,
  });
  return attachmentId;
}

test("getAttachmentsByIds returns only attachments owned by the given user", async () => {
  const now = new Date();
  const ownerId = await seedUser(now);
  const foreignId = await seedUser(now);
  const ownerConversationId = await seedConversation(ownerId, now);
  const foreignConversationId = await seedConversation(foreignId, now);
  const ownedAttachmentId = await seedConversationAttachment(ownerConversationId, now);
  const foreignAttachmentId = await seedConversationAttachment(foreignConversationId, now);

  try {
    const rows = await getAttachmentsByIds([ownedAttachmentId, foreignAttachmentId], ownerId);

    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(ownedAttachmentId);
  } finally {
    await db.delete(attachments).where(eq(attachments.id, ownedAttachmentId));
    await db.delete(attachments).where(eq(attachments.id, foreignAttachmentId));
    await db.delete(conversations).where(eq(conversations.id, ownerConversationId));
    await db.delete(conversations).where(eq(conversations.id, foreignConversationId));
    await db.delete(users).where(eq(users.id, ownerId));
    await db.delete(users).where(eq(users.id, foreignId));
  }
});

test("getAttachmentsByIds recognizes session-owned attachments", async () => {
  const now = new Date();
  const ownerId = await seedUser(now);
  const sessionId = crypto.randomUUID();
  await db.insert(agentSessions).values({
    id: sessionId,
    userId: ownerId,
    conversationId: null,
    channelId: null,
    modelId: null,
    title: "session",
    status: "active",
    createdAt: now,
    updatedAt: now,
  });
  const attachmentId = crypto.randomUUID();
  await db.insert(attachments).values({
    id: attachmentId,
    conversationId: null,
    sessionId,
    messageId: null,
    fileName: "file.txt",
    filePath: "/tmp/file.txt",
    fileType: "text/plain",
    fileSize: 1,
    createdAt: now,
  });

  try {
    const owned = await getAttachmentsByIds([attachmentId], ownerId);
    const foreign = await getAttachmentsByIds([attachmentId], crypto.randomUUID());

    expect(owned).toHaveLength(1);
    expect(foreign).toHaveLength(0);
  } finally {
    await db.delete(attachments).where(eq(attachments.id, attachmentId));
    await db.delete(agentSessions).where(eq(agentSessions.id, sessionId));
    await db.delete(users).where(eq(users.id, ownerId));
  }
});

test("linkAttachmentsToMessage links only attachments owned by the given user", async () => {
  const now = new Date();
  const ownerId = await seedUser(now);
  const foreignId = await seedUser(now);
  const ownerConversationId = await seedConversation(ownerId, now);
  const foreignConversationId = await seedConversation(foreignId, now);
  const ownedAttachmentId = await seedConversationAttachment(ownerConversationId, now);
  const foreignAttachmentId = await seedConversationAttachment(foreignConversationId, now);

  const targetMessageId = crypto.randomUUID();
  await db.insert(messages).values({
    id: targetMessageId,
    conversationId: ownerConversationId,
    role: "user",
    content: "hello",
    model: null,
    mode: "chat",
    attachments: null,
    agentRun: null,
    workspaceId: null,
    contextPaths: null,
    liveMetadata: null,
    citations: null,
    createdAt: now,
  });

  try {
    await linkAttachmentsToMessage(
      [ownedAttachmentId, foreignAttachmentId],
      targetMessageId,
      ownerId,
    );

    const ownedRow = await db
      .select()
      .from(attachments)
      .where(eq(attachments.id, ownedAttachmentId));
    const foreignRow = await db
      .select()
      .from(attachments)
      .where(eq(attachments.id, foreignAttachmentId));

    expect(ownedRow[0].messageId).toBe(targetMessageId);
    // Foreign attachment must remain unlinked (null messageId).
    expect(foreignRow[0].messageId).toEqual(null);
  } finally {
    await db.delete(attachments).where(eq(attachments.id, ownedAttachmentId));
    await db.delete(attachments).where(eq(attachments.id, foreignAttachmentId));
    await db.delete(messages).where(eq(messages.id, targetMessageId));
    await db.delete(conversations).where(eq(conversations.id, ownerConversationId));
    await db.delete(conversations).where(eq(conversations.id, foreignConversationId));
    await db.delete(users).where(eq(users.id, ownerId));
    await db.delete(users).where(eq(users.id, foreignId));
  }
});
