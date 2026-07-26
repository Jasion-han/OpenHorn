import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { attachments, conversations, messages, users } from "db";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { bootstrapDatabase } from "../db/bootstrap";
import { generateId } from "../utils";
import { deleteConversation } from "./conversationService";
import { deleteMessage } from "./messageService";

async function seedUser() {
  const userId = generateId();
  const now = new Date();
  await db.insert(users).values({
    id: userId,
    email: `${userId}@test.local`,
    username: "attachment-cleanup",
    passwordHash: "x",
    createdAt: now,
    updatedAt: now,
  });
  return userId;
}

/** Creates a conversation + message + attachment whose blob really exists on disk. */
async function seedAttachment(userId: string) {
  const now = new Date();
  const conversationId = generateId();
  const messageId = generateId();
  const dir = mkdtempSync(path.join(os.tmpdir(), "openhorn-blob-"));
  const filePath = path.join(dir, "payload.png");
  writeFileSync(filePath, "binary-ish");

  await db.insert(conversations).values({
    id: conversationId,
    userId,
    title: "cleanup",
    contextLength: 4096,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(messages).values({
    id: messageId,
    conversationId,
    role: "user",
    content: "see attachment",
    createdAt: now,
  });
  await db.insert(attachments).values({
    id: generateId(),
    conversationId,
    messageId,
    fileName: "payload.png",
    filePath,
    fileType: "image/png",
    fileSize: 10,
    createdAt: now,
  });

  return { conversationId, messageId, filePath };
}

describe("attachment blobs are reclaimed on delete", () => {
  test("deleting a conversation removes its attachment files", async () => {
    await bootstrapDatabase();
    const userId = await seedUser();
    const { conversationId, filePath } = await seedAttachment(userId);
    expect(existsSync(filePath)).toBe(true);

    await deleteConversation(userId, conversationId);

    expect(existsSync(filePath)).toBe(false);
    const rows = await db
      .select()
      .from(attachments)
      .where(eq(attachments.conversationId, conversationId));
    expect(rows).toHaveLength(0);
  });

  test("deleting a single message removes its attachment files", async () => {
    await bootstrapDatabase();
    const userId = await seedUser();
    const { messageId, filePath } = await seedAttachment(userId);
    expect(existsSync(filePath)).toBe(true);

    await deleteMessage(userId, messageId);

    expect(existsSync(filePath)).toBe(false);
  });
});
