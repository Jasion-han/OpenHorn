import { expect, test } from "bun:test";
import { attachments, conversations, messages, sidecarSyncReceipts, users } from "db";
import { eq } from "drizzle-orm";
import { client, db } from "../db";
import { bootstrapDatabase } from "../db/bootstrap";
import { deleteMessage, syncSidecarMessages } from "./messageService";

type Input = Parameters<typeof syncSidecarMessages>[1];

async function fixture() {
  const userId = crypto.randomUUID();
  const conversationId = crypto.randomUUID();
  const now = new Date();
  await db.insert(users).values({
    id: userId,
    email: `${userId}@receipt.test.invalid`,
    username: "receipt",
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(conversations).values({
    id: conversationId,
    userId,
    title: "Receipt fixture",
    createdAt: now,
    updatedAt: now,
  });
  const input: Input = {
    conversationId,
    userMessageId: crypto.randomUUID(),
    assistantMessageId: crypto.randomUUID(),
    userContent: "old question",
    assistantContent: "old answer",
    agentRun: { status: "completed", steps: [{ type: "text", content: "old answer" }] },
    syncRevision: { sessionId: crypto.randomUUID(), sequence: 1 },
    attachmentsMeta: [{ fileName: "old.txt", fileType: "text/plain", fileSize: 3 }],
  };
  return {
    userId,
    conversationId,
    input,
    rows: () => db.select().from(messages).where(eq(messages.conversationId, conversationId)),
    close: async () => {
      await db.delete(conversations).where(eq(conversations.id, conversationId));
      await db.delete(users).where(eq(users.id, userId));
    },
  };
}

function receiptAck(saved: { userMessageId: string; assistantMessageId: string }) {
  return {
    userMessageId: saved.userMessageId,
    assistantMessageId: saved.assistantMessageId,
    replayed: true,
  };
}

function nextSession(input: Input): Input {
  return {
    ...input,
    userContent: "new question",
    assistantContent: "new answer",
    agentRun: { status: "completed", steps: [{ type: "text", content: "new answer" }] },
    syncRevision: { sessionId: crypto.randomUUID(), sequence: 1 },
    attachmentsMeta: [{ fileName: "new.txt", fileType: "text/plain", fileSize: 7 }],
  };
}

test("a lost ACK replay after another desktop session cannot overwrite newer text or metadata", async () => {
  const f = await fixture();
  try {
    const saved = await syncSidecarMessages(f.userId, f.input);
    await syncSidecarMessages(f.userId, nextSession(f.input));
    const restartedService = await import(
      `./messageService?receipt-restart=${crypto.randomUUID()}`
    );
    const replay = await restartedService.syncSidecarMessages(f.userId, structuredClone(f.input));
    expect(replay).toMatchObject(receiptAck(saved));
    expect((await f.rows()).map((row) => row.content)).toEqual(["new question", "new answer"]);
    expect(
      (
        await db.select().from(attachments).where(eq(attachments.conversationId, f.conversationId))
      ).map((row) => row.fileName),
    ).toEqual(["new.txt"]);
    const indexed = await client.execute({
      sql: "SELECT content FROM messages_fts WHERE message_id = ?",
      args: [saved.assistantMessageId],
    });
    expect(indexed.rows.map((row) => row.content)).toEqual(["new answer"]);
  } finally {
    await f.close();
  }
});

test("saved operation receipts prevent deleted assistant or entire turn resurrection", async () => {
  const f = await fixture();
  try {
    const saved = await syncSidecarMessages(f.userId, f.input);
    await deleteMessage(f.userId, saved.assistantMessageId);
    expect(await syncSidecarMessages(f.userId, f.input)).toEqual(receiptAck(saved));
    expect((await f.rows()).map((row) => row.role)).toEqual(["user"]);
    await deleteMessage(f.userId, saved.userMessageId);
    expect(await syncSidecarMessages(f.userId, f.input)).toEqual(receiptAck(saved));
    expect(await f.rows()).toHaveLength(0);
    expect(
      await db.select().from(attachments).where(eq(attachments.conversationId, f.conversationId)),
    ).toHaveLength(0);
    const indexed = await client.execute({
      sql: "SELECT message_id FROM messages_fts WHERE conversation_id = ?",
      args: [f.conversationId],
    });
    expect(indexed.rows).toHaveLength(0);
    expect(
      await db.select().from(sidecarSyncReceipts).where(eq(sidecarSyncReceipts.userId, f.userId)),
    ).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test("receipt identities are immutable and operation keys are scoped to the owning user", async () => {
  const f = await fixture();
  const other = await fixture();
  const alternateConversationId = crypto.randomUUID();
  try {
    const saved = await syncSidecarMessages(f.userId, f.input);
    await db.insert(conversations).values({
      id: alternateConversationId,
      userId: f.userId,
      title: "Other owned conversation",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    for (const input of [
      { ...f.input, conversationId: alternateConversationId },
      { ...f.input, userMessageId: crypto.randomUUID() },
      { ...f.input, assistantMessageId: crypto.randomUUID() },
      {
        ...f.input,
        userMessageId: f.input.assistantMessageId,
        assistantMessageId: f.input.userMessageId,
      },
    ]) {
      await expect(syncSidecarMessages(f.userId, input)).rejects.toThrow(
        "Sidecar sync revision belongs to different message identities",
      );
    }
    const independent = await syncSidecarMessages(other.userId, {
      ...other.input,
      syncRevision: f.input.syncRevision,
    });
    expect(independent.userMessageId).toBe(other.input.userMessageId);
    expect(independent).toMatchObject({
      userMessageId: other.input.userMessageId,
      assistantMessageId: other.input.assistantMessageId,
    });
    await expect(syncSidecarMessages(other.userId, f.input)).rejects.toThrow(
      "Conversation not found",
    );
    expect(await syncSidecarMessages(f.userId, f.input)).toEqual(receiptAck(saved));
    expect((await f.rows()).map((row) => row.content)).toEqual(["old question", "old answer"]);
    expect(await other.rows()).toHaveLength(2);
  } finally {
    await db.delete(conversations).where(eq(conversations.id, alternateConversationId));
    await f.close();
    await other.close();
  }
});

test("an acknowledged same-session obsolete operation stays obsolete after a newer session saves", async () => {
  const f = await fixture();
  try {
    const later = {
      ...nextSession(f.input),
      syncRevision: { sessionId: f.input.syncRevision?.sessionId ?? "", sequence: 2 },
    };
    const saved = await syncSidecarMessages(f.userId, later);
    expect(await syncSidecarMessages(f.userId, f.input)).toEqual(receiptAck(saved));
    await syncSidecarMessages(f.userId, {
      ...nextSession(f.input),
      userContent: "latest question",
      agentRun: { status: "completed", steps: [{ type: "text", content: "latest answer" }] },
    });
    expect(await syncSidecarMessages(f.userId, f.input)).toEqual(receiptAck(saved));
    expect((await f.rows()).map((row) => row.content)).toEqual([
      "latest question",
      "latest answer",
    ]);
    expect(
      await db.select().from(sidecarSyncReceipts).where(eq(sidecarSyncReceipts.userId, f.userId)),
    ).toHaveLength(3);
  } finally {
    await f.close();
  }
});

test("receipt insert failure rolls back messages, attachment metadata and FTS together", async () => {
  const f = await fixture();
  const trigger = `receipt_failure_${crypto.randomUUID().replaceAll("-", "")}`;
  try {
    await client.execute(
      `CREATE TRIGGER ${trigger} BEFORE INSERT ON sidecar_sync_receipts WHEN NEW.user_id = '${f.userId}' BEGIN SELECT RAISE(ABORT, 'synthetic receipt failure'); END`,
    );
    await expect(syncSidecarMessages(f.userId, f.input)).rejects.toThrow();
    expect(await f.rows()).toHaveLength(0);
    expect(
      await db.select().from(attachments).where(eq(attachments.conversationId, f.conversationId)),
    ).toHaveLength(0);
    expect(
      await db.select().from(sidecarSyncReceipts).where(eq(sidecarSyncReceipts.userId, f.userId)),
    ).toHaveLength(0);
    const indexed = await client.execute({
      sql: "SELECT message_id FROM messages_fts WHERE conversation_id = ?",
      args: [f.conversationId],
    });
    expect(indexed.rows).toHaveLength(0);
    await client.execute(`DROP TRIGGER ${trigger}`);
    const saved = await syncSidecarMessages(f.userId, f.input);
    expect(await f.rows()).toHaveLength(2);
    expect(await syncSidecarMessages(f.userId, f.input)).toEqual(receiptAck(saved));
  } finally {
    await client.execute(`DROP TRIGGER IF EXISTS ${trigger}`);
    await f.close();
  }
});

test("receipt-backed no-ID calls replay generated identities while revision-free legacy calls remain independent", async () => {
  const f = await fixture();
  try {
    const input = { ...f.input, userMessageId: undefined, assistantMessageId: undefined };
    const saved = await syncSidecarMessages(f.userId, input);
    expect(await syncSidecarMessages(f.userId, input)).toEqual(receiptAck(saved));
    await deleteMessage(f.userId, saved.assistantMessageId);
    expect(await syncSidecarMessages(f.userId, input)).toEqual(receiptAck(saved));
    expect(await f.rows()).toHaveLength(1);
    const legacy = { ...input, syncRevision: undefined };
    const first = await syncSidecarMessages(f.userId, legacy);
    const second = await syncSidecarMessages(f.userId, legacy);
    expect(first.assistantMessageId === second.assistantMessageId).toBe(false);
    expect(await f.rows()).toHaveLength(5);
  } finally {
    await f.close();
  }
});

test("receipts survive repeated bootstrap but cascade with conversation deletion", async () => {
  const f = await fixture();
  try {
    const saved = await syncSidecarMessages(f.userId, f.input);
    await bootstrapDatabase();
    await bootstrapDatabase();
    expect(await syncSidecarMessages(f.userId, f.input)).toEqual(receiptAck(saved));
    await db.delete(conversations).where(eq(conversations.id, f.conversationId));
    expect(
      await db.select().from(sidecarSyncReceipts).where(eq(sidecarSyncReceipts.userId, f.userId)),
    ).toHaveLength(0);
    await expect(syncSidecarMessages(f.userId, f.input)).rejects.toThrow("Conversation not found");
    expect(await f.rows()).toHaveLength(0);
  } finally {
    await f.close();
  }
});

test("concurrent retries acknowledge one committed operation and create one receipt", async () => {
  const f = await fixture();
  try {
    const attempts = await Promise.allSettled([
      syncSidecarMessages(f.userId, f.input),
      syncSidecarMessages(f.userId, structuredClone(f.input)),
    ]);
    expect(attempts.every((attempt) => attempt.status === "fulfilled")).toBe(true);
    const results = attempts.flatMap((attempt) =>
      attempt.status === "fulfilled" ? [attempt.value] : [],
    );
    expect(results.filter((result) => result.replayed === true)).toHaveLength(1);
    expect(results.map((result) => result.assistantMessageId)).toEqual([
      f.input.assistantMessageId,
      f.input.assistantMessageId,
    ]);
    expect(await f.rows()).toHaveLength(2);
    expect(
      await db.select().from(sidecarSyncReceipts).where(eq(sidecarSyncReceipts.userId, f.userId)),
    ).toHaveLength(1);
    expect(
      await db.select().from(attachments).where(eq(attachments.conversationId, f.conversationId)),
    ).toHaveLength(1);
  } finally {
    await f.close();
  }
});
