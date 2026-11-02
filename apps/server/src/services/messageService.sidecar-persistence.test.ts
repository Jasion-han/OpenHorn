import { expect, test } from "bun:test";
import { attachments, conversations, messages, users } from "db";
import { eq } from "drizzle-orm";
import { client, db } from "../db";
import { deleteMessage, syncSidecarMessages } from "./messageService";

type Input = Parameters<typeof syncSidecarMessages>[1];
async function fixture() {
  const userId = crypto.randomUUID();
  const conversationId = crypto.randomUUID();
  const now = new Date();
  await db.insert(users).values({
    id: userId,
    email: `${userId}@test.local`,
    username: "save-recovery",
    passwordHash: "x",
    createdAt: now,
    updatedAt: now,
  });
  await db
    .insert(conversations)
    .values({ id: conversationId, userId, title: "save recovery", createdAt: now, updatedAt: now });
  const input: Input = {
    conversationId,
    userContent: "question",
    assistantContent: "answer",
    model: "fixture",
    userMessageId: crypto.randomUUID(),
    assistantMessageId: crypto.randomUUID(),
    agentRun: { status: "completed", steps: [{ type: "text", content: "answer" }] },
    syncRevision: { sessionId: crypto.randomUUID(), sequence: 1 },
    attachmentsMeta: [{ fileName: "fixture.txt", fileType: "text/plain", fileSize: 12 }],
  };
  return {
    userId,
    conversationId,
    input,
    rows: () => db.select().from(messages).where(eq(messages.conversationId, conversationId)),
    close: async () => {
      await db.delete(attachments).where(eq(attachments.conversationId, conversationId));
      await db.delete(messages).where(eq(messages.conversationId, conversationId));
      await db.delete(conversations).where(eq(conversations.id, conversationId));
      await db.delete(users).where(eq(users.id, userId));
    },
  };
}

test("stable sidecar IDs and revisions make lost ACK retries idempotent", async () => {
  const f = await fixture();
  try {
    const first = await syncSidecarMessages(f.userId, f.input);
    const second = await syncSidecarMessages(f.userId, structuredClone(f.input));
    expect(second).toEqual(first);
    expect(await f.rows()).toHaveLength(2);
    const meta = await db
      .select()
      .from(attachments)
      .where(eq(attachments.messageId, first.userMessageId));
    expect(meta).toHaveLength(1);
    const newer = {
      ...f.input,
      userContent: "new question",
      agentRun: { status: "completed", steps: [{ type: "text", content: "new answer" }] },
      syncRevision: { ...f.input.syncRevision, sequence: 2 },
    };
    await syncSidecarMessages(f.userId, newer);
    await syncSidecarMessages(f.userId, f.input);
    const rows = await f.rows();
    expect(rows.find((row) => row.role === "user")?.content).toBe("new question");
    expect(rows.find((row) => row.role === "assistant")?.content).toBe("new answer");
    const indexed = await client.execute({
      sql: "SELECT content FROM messages_fts WHERE message_id = ?",
      args: [first.assistantMessageId],
    });
    expect(indexed.rows.map((row) => row.content)).toEqual(["new answer"]);
  } finally {
    await f.close();
  }
});

test("user and assistant writes roll back together if the second insert fails", async () => {
  const f = await fixture();
  const trigger = `save_failure_${crypto.randomUUID().replaceAll("-", "")}`;
  try {
    await client.execute(
      `CREATE TRIGGER ${trigger} BEFORE INSERT ON messages WHEN NEW.role = 'assistant' AND NEW.conversation_id = '${f.conversationId}' BEGIN SELECT RAISE(ABORT, 'synthetic assistant failure'); END`,
    );
    await expect(syncSidecarMessages(f.userId, f.input)).rejects.toThrow();
    expect(await f.rows()).toHaveLength(0);
    expect(
      await db.select().from(attachments).where(eq(attachments.conversationId, f.conversationId)),
    ).toHaveLength(0);
  } finally {
    await client.execute(`DROP TRIGGER IF EXISTS ${trigger}`);
    await f.close();
  }
});

test("partial pairs, wrong roles, identity collisions, and foreign conversations reject atomically", async () => {
  const f = await fixture();
  const other = await fixture();
  try {
    await syncSidecarMessages(f.userId, f.input);
    await syncSidecarMessages(other.userId, other.input);
    const invalid: Input[] = [
      { ...f.input, assistantMessageId: crypto.randomUUID() },
      { ...f.input, userMessageId: crypto.randomUUID() },
      {
        ...f.input,
        userMessageId: f.input.assistantMessageId,
        assistantMessageId: f.input.userMessageId,
      },
      {
        ...f.input,
        userMessageId: other.input.userMessageId,
        assistantMessageId: other.input.assistantMessageId,
      },
      {
        ...f.input,
        userMessageId: crypto.randomUUID(),
        assistantMessageId: undefined,
        newAssistantMessageId: crypto.randomUUID(),
      },
      {
        ...f.input,
        userMessageId: f.input.userMessageId,
        assistantMessageId: f.input.userMessageId,
      },
    ];
    for (const input of invalid)
      await expect(syncSidecarMessages(f.userId, input)).rejects.toThrow();
    await expect(syncSidecarMessages(other.userId, f.input)).rejects.toThrow(
      "Conversation not found",
    );
    expect((await f.rows()).map((row) => row.content)).toEqual(["question", "answer"]);
    expect(await other.rows()).toHaveLength(2);
  } finally {
    await f.close();
    await other.close();
  }
});

test("existing opaque imported IDs remain valid for pair updates and unanswered user retries", async () => {
  for (const pair of [true, false]) {
    const f = await fixture();
    try {
      const userId = `imported-user:${crypto.randomUUID()}`;
      const assistantId = `imported-reply:${crypto.randomUUID()}`;
      await db.insert(messages).values({
        id: userId,
        conversationId: f.conversationId,
        role: "user",
        content: "old",
        mode: "agent",
        createdAt: new Date(),
      });
      if (pair)
        await db.insert(messages).values({
          id: assistantId,
          conversationId: f.conversationId,
          role: "assistant",
          content: "old",
          mode: "agent",
          createdAt: new Date(),
        });
      const input: Input = {
        ...f.input,
        userMessageId: userId,
        assistantMessageId: pair ? assistantId : undefined,
        ...(pair ? {} : { newAssistantMessageId: crypto.randomUUID() }),
      };
      const first = await syncSidecarMessages(f.userId, input);
      const repeated = await syncSidecarMessages(f.userId, input);
      expect(repeated).toEqual(first);
      expect(first.userMessageId).toBe(userId);
      expect(await f.rows()).toHaveLength(2);
      if (pair) expect(first.assistantMessageId).toBe(assistantId);
    } finally {
      await f.close();
    }
  }
});

test("new client-selected identities must be UUIDs while legacy no-ID calls still insert", async () => {
  const f = await fixture();
  try {
    await expect(
      syncSidecarMessages(f.userId, {
        ...f.input,
        userMessageId: "new-opaque-user",
        assistantMessageId: "new-opaque-assistant",
      }),
    ).rejects.toThrow("UUID");
    const result = await syncSidecarMessages(f.userId, {
      ...f.input,
      userMessageId: undefined,
      assistantMessageId: undefined,
      syncRevision: undefined,
    });
    expect(result.userMessageId).toMatch(/^[0-9a-f-]{36}$/);
    expect(await f.rows()).toHaveLength(2);
  } finally {
    await f.close();
  }
});

test("malformed revision and message identity shapes reject without writing", async () => {
  const f = await fixture();
  try {
    for (const syncRevision of [
      null,
      [],
      "revision",
      { sessionId: 42, sequence: 1 },
      { sessionId: "x", sequence: 1 },
      { sessionId: crypto.randomUUID(), sequence: 0 },
      { sessionId: crypto.randomUUID(), sequence: 1.5 },
      { sessionId: crypto.randomUUID(), sequence: Number.MAX_SAFE_INTEGER + 1 },
    ]) {
      await expect(
        syncSidecarMessages(f.userId, { ...f.input, syncRevision } as Input),
      ).rejects.toThrow("revision");
    }
    for (const userMessageId of [null, 42, ""]) {
      await expect(
        syncSidecarMessages(f.userId, { ...f.input, userMessageId } as Input),
      ).rejects.toThrow();
    }
    expect(await f.rows()).toHaveLength(0);
  } finally {
    await f.close();
  }
});

test("Agent mode cannot store Chat length status without a valid Agent run", async () => {
  const f = await fixture();
  try {
    const result = await syncSidecarMessages(f.userId, {
      ...f.input,
      agentRun: undefined,
      syncRevision: undefined,
      finishReason: "length",
    });
    const rows = await f.rows();
    expect(rows.find((row) => row.id === result.assistantMessageId)?.finishReason).toBeNull();
  } finally {
    await f.close();
  }
});

test("deleting an unsaved stable ID is idempotent while foreign existing rows remain protected", async () => {
  const f = await fixture();
  const other = await fixture();
  try {
    expect(await deleteMessage(f.userId, f.input.assistantMessageId ?? "missing")).toEqual({
      success: true,
    });
    await syncSidecarMessages(f.userId, f.input);
    await expect(
      deleteMessage(other.userId, f.input.assistantMessageId ?? "missing"),
    ).rejects.toThrow("Conversation not found");
    await deleteMessage(f.userId, f.input.assistantMessageId ?? "missing");
    await deleteMessage(f.userId, f.input.assistantMessageId ?? "missing");
    expect((await f.rows()).map((row) => row.role)).toEqual(["user"]);
  } finally {
    await f.close();
    await other.close();
  }
});
