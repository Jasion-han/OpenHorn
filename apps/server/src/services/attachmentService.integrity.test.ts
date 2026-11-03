import { expect, test } from "bun:test";
import { attachments, conversations, messages, users } from "db";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { linkAttachmentsToMessage } from "./attachmentService";

async function fixture(
  run: (ids: {
    userId: string;
    foreignUserId: string;
    conversationId: string;
    otherConversationId: string;
    first: string;
    second: string;
    other: string;
    foreign: string;
    assistant: string;
    attachmentId: string;
    freshId: string;
  }) => Promise<void>,
) {
  const now = new Date();
  const ids = Object.fromEntries(
    [
      "userId",
      "foreignUserId",
      "conversationId",
      "otherConversationId",
      "first",
      "second",
      "other",
      "foreign",
      "assistant",
      "attachmentId",
      "freshId",
    ].map((key) => [key, crypto.randomUUID()]),
  ) as Parameters<typeof run>[0];
  const foreignConversation = crypto.randomUUID();
  await db.insert(users).values(
    [ids.userId, ids.foreignUserId].map((id) => ({
      id,
      email: `${id}@test.local`,
      username: "attachment-integrity",
      passwordHash: "x",
      createdAt: now,
      updatedAt: now,
    })),
  );
  await db.insert(conversations).values(
    [
      { id: ids.conversationId, userId: ids.userId },
      { id: ids.otherConversationId, userId: ids.userId },
      { id: foreignConversation, userId: ids.foreignUserId },
    ].map((row) => ({ ...row, title: "fixture", createdAt: now, updatedAt: now })),
  );
  await db.insert(messages).values(
    [
      { id: ids.first, conversationId: ids.conversationId, role: "user" },
      { id: ids.second, conversationId: ids.conversationId, role: "user" },
      { id: ids.assistant, conversationId: ids.conversationId, role: "assistant" },
      { id: ids.other, conversationId: ids.otherConversationId, role: "user" },
      { id: ids.foreign, conversationId: foreignConversation, role: "user" },
    ].map((row) => ({
      ...row,
      content: "fixture",
      mode: "chat",
      attachments: JSON.stringify([ids.attachmentId, ids.freshId]),
      createdAt: now,
    })),
  );
  await db.insert(attachments).values(
    [
      { id: ids.attachmentId, messageId: ids.first },
      { id: ids.freshId, messageId: null },
    ].map((row) => ({
      ...row,
      conversationId: ids.conversationId,
      fileName: "fixture.txt",
      filePath: "local:fixture.txt",
      fileType: "text/plain",
      fileSize: 1,
      createdAt: now,
    })),
  );
  try {
    await run(ids);
  } finally {
    for (const id of [ids.conversationId, ids.otherConversationId, foreignConversation]) {
      await db.delete(attachments).where(eq(attachments.conversationId, id));
      await db.delete(messages).where(eq(messages.conversationId, id));
      await db.delete(conversations).where(eq(conversations.id, id));
    }
    await db.delete(users).where(eq(users.id, ids.userId));
    await db.delete(users).where(eq(users.id, ids.foreignUserId));
  }
}
const attachment = async (id: string) =>
  (await db.select().from(attachments).where(eq(attachments.id, id)))[0];
const message = async (id: string) =>
  (await db.select().from(messages).where(eq(messages.id, id)))[0];

test("an attachment bound to one message cannot be stolen by a later message", async () => {
  await fixture(async (ids) => {
    await linkAttachmentsToMessage([ids.attachmentId], ids.second, ids.userId);
    expect((await attachment(ids.attachmentId)).messageId).toBe(ids.first);
    expect((await message(ids.second)).attachments).toBe(null);
  });
});
test("same-owner cross-conversation linking neither moves the source nor stores invalid IDs", async () => {
  await fixture(async (ids) => {
    await linkAttachmentsToMessage([ids.freshId], ids.other, ids.userId);
    expect((await attachment(ids.freshId)).messageId).toBe(null);
    expect((await message(ids.other)).attachments).toBe(null);
  });
});
for (const kind of ["foreign", "assistant", "missing"] as const) {
  test(`attachment linking rejects a ${kind} target before modifying the upload`, async () => {
    await fixture(async (ids) => {
      let rejected = false;
      try {
        await linkAttachmentsToMessage(
          [ids.freshId],
          kind === "missing" ? crypto.randomUUID() : ids[kind],
          ids.userId,
        );
      } catch {
        rejected = true;
      }
      expect(rejected).toBe(true);
      expect((await attachment(ids.freshId)).messageId).toBe(null);
    });
  });
}
test("valid fresh uploads and exact-message retries keep real binding metadata consistent", async () => {
  await fixture(async (ids) => {
    await linkAttachmentsToMessage(
      [ids.freshId, ids.attachmentId, crypto.randomUUID()],
      ids.first,
      ids.userId,
    );
    expect((await attachment(ids.freshId)).messageId).toBe(ids.first);
    expect(new Set(JSON.parse((await message(ids.first)).attachments || "[]"))).toEqual(
      new Set([ids.attachmentId, ids.freshId]),
    );
    await linkAttachmentsToMessage([ids.attachmentId], ids.first, ids.userId);
    expect(new Set(JSON.parse((await message(ids.first)).attachments || "[]"))).toEqual(
      new Set([ids.attachmentId, ids.freshId]),
    );
  });
});

test("attachment binding reuses the caller transaction and rolls back with its user turn", async () => {
  await fixture(async (ids) => {
    const original = (await message(ids.first)).attachments;
    let rejected = false;
    try {
      await db.transaction(async (tx) => {
        await linkAttachmentsToMessage([ids.freshId], ids.first, ids.userId, tx);
        throw new Error("Synthetic caller rollback");
      });
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(true);
    expect((await attachment(ids.freshId)).messageId).toBe(null);
    expect((await message(ids.first)).attachments).toBe(original);
  });
});
