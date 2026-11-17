import { expect, test } from "bun:test";
import { conversations, messages, sidecarSyncReceipts, users } from "db";
import { eq } from "drizzle-orm";
import { client, db } from "../db";
import { messageSaveToken } from "./messageSaveToken";
import { getMessagesForUserWithAttachments, syncSidecarMessages } from "./messageService";

type Input = Parameters<typeof syncSidecarMessages>[1];

async function fixture() {
  const userId = crypto.randomUUID();
  const conversationId = crypto.randomUUID();
  const now = new Date();
  await db.insert(users).values({
    id: userId,
    email: `${userId}@save-cas.test.invalid`,
    username: "save-cas",
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(conversations).values({
    id: conversationId,
    userId,
    title: "Save CAS fixture",
    createdAt: now,
    updatedAt: now,
  });
  const input: Input = {
    conversationId,
    userMessageId: crypto.randomUUID(),
    assistantMessageId: crypto.randomUUID(),
    userContent: "baseline question",
    assistantContent: "baseline answer",
    agentRun: { status: "completed", steps: [{ type: "text", content: "baseline answer" }] },
    syncRevision: { sessionId: crypto.randomUUID(), sequence: 1 },
    expectedUserToken: null,
    expectedAssistantToken: null,
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

function request(input: Input, content: string): Input {
  return {
    ...input,
    userContent: `${content} question`,
    assistantContent: `${content} answer`,
    agentRun: { status: "completed", steps: [{ type: "text", content: `${content} answer` }] },
    syncRevision: { sessionId: crypto.randomUUID(), sequence: 1 },
  };
}

test("first save returns stable tokens and list tokens track every persisted message field", async () => {
  const f = await fixture();
  try {
    const saved = await syncSidecarMessages(f.userId, f.input);
    const listed = await getMessagesForUserWithAttachments(f.userId, f.conversationId);
    expect(saved.saveTokens?.user).toMatch(/^[a-f0-9]{64}$/);
    expect(saved.saveTokens?.assistant).toMatch(/^[a-f0-9]{64}$/);
    expect(listed.find((row) => row.role === "user")?.saveToken).toBe(saved.saveTokens?.user);
    expect(listed.find((row) => row.role === "assistant")?.saveToken).toBe(
      saved.saveTokens?.assistant,
    );
    const row = (await f.rows()).find((message) => message.role === "assistant");
    if (!row) throw new Error("Missing synthetic message");
    expect(messageSaveToken({ ...row })).toBe(messageSaveToken(row));
    for (const update of [
      { content: "changed" },
      { model: "changed" },
      { mode: "chat" },
      { agentRun: "{}" },
      { attachments: "[]" },
      { usage: "{}" },
      { finishReason: "stopped" },
      { updatedAt: new Date(row.createdAt.getTime() + 1000) },
    ]) {
      expect(messageSaveToken({ ...row, ...update }) === messageSaveToken(row)).toBe(false);
    }
  } finally {
    await f.close();
  }
});

test("an uncommitted old desktop save arriving after a different session update conflicts atomically", async () => {
  const f = await fixture();
  try {
    const saved = await syncSidecarMessages(f.userId, f.input);
    const old = request(
      {
        ...f.input,
        expectedUserToken: saved.saveTokens?.user,
        expectedAssistantToken: saved.saveTokens?.assistant,
      },
      "old pending",
    );
    const newer = request(old, "new desktop");
    await syncSidecarMessages(f.userId, newer);
    await expect(syncSidecarMessages(f.userId, { ...old, recovery: true })).rejects.toMatchObject({
      code: "sidecar_save_conflict",
    });
    expect((await f.rows()).map((row) => row.content)).toEqual([
      "new desktop question",
      "new desktop answer",
    ]);
    const receipts = await db
      .select()
      .from(sidecarSyncReceipts)
      .where(eq(sidecarSyncReceipts.userId, f.userId));
    expect(receipts).toHaveLength(2);
    const indexed = await client.execute({
      sql: "SELECT content FROM messages_fts WHERE message_id = ?",
      args: [saved.assistantMessageId],
    });
    expect(indexed.rows.map((row) => row.content)).toEqual(["new desktop answer"]);
  } finally {
    await f.close();
  }
});

test("a higher acknowledged sequence permanently fences a lower first arrival across sessions", async () => {
  const f = await fixture();
  try {
    const sessionId = crypto.randomUUID();
    const high = { ...request(f.input, "high sequence"), syncRevision: { sessionId, sequence: 2 } };
    const highSave = await syncSidecarMessages(f.userId, high);
    await syncSidecarMessages(
      f.userId,
      request(
        {
          ...high,
          expectedUserToken: highSave.saveTokens?.user,
          expectedAssistantToken: highSave.saveTokens?.assistant,
        },
        "other session",
      ),
    );
    const low = {
      ...request(f.input, "low sequence"),
      syncRevision: { sessionId, sequence: 1 },
      expectedUserToken: undefined,
      expectedAssistantToken: undefined,
      recovery: true,
    };
    const replay = await syncSidecarMessages(f.userId, low);
    expect(replay.replayed).toBe(true);
    expect((await f.rows()).map((row) => row.content)).toEqual([
      "other session question",
      "other session answer",
    ]);
    expect(await syncSidecarMessages(f.userId, low)).toMatchObject({ replayed: true });
  } finally {
    await f.close();
  }
});

test("same-session newer sequences accept the older baseline while older arrivals never overwrite", async () => {
  const f = await fixture();
  try {
    const sessionId = crypto.randomUUID();
    const first = { ...f.input, syncRevision: { sessionId, sequence: 1 } };
    const second = {
      ...request(f.input, "second"),
      syncRevision: { sessionId, sequence: 2 },
      recovery: true,
    };
    const attempts = await Promise.allSettled([
      syncSidecarMessages(f.userId, first),
      syncSidecarMessages(f.userId, second),
    ]);
    expect(attempts.every((attempt) => attempt.status === "fulfilled")).toBe(true);
    expect((await f.rows()).map((row) => row.content)).toEqual([
      "second question",
      "second answer",
    ]);
    expect(await syncSidecarMessages(f.userId, first)).toMatchObject({ replayed: true });
  } finally {
    await f.close();
  }
});

test("explicit absent baselines protect existing rows, legacy undefined stays compatible, old recovery cannot bypass", async () => {
  const f = await fixture();
  try {
    await syncSidecarMessages(f.userId, f.input);
    await expect(
      syncSidecarMessages(f.userId, request(f.input, "absent baseline")),
    ).rejects.toMatchObject({ code: "sidecar_save_conflict" });
    await expect(
      syncSidecarMessages(f.userId, {
        ...request(f.input, "opaque wrong baseline"),
        expectedUserToken: "outdated-token",
        expectedAssistantToken: "outdated-token",
      }),
    ).rejects.toMatchObject({ code: "sidecar_save_conflict" });
    const legacy = {
      ...request(f.input, "legacy"),
      expectedUserToken: undefined,
      expectedAssistantToken: undefined,
    };
    await syncSidecarMessages(f.userId, legacy);
    const oldRecovery = { ...request(legacy, "unconfirmed old disk record"), recovery: true };
    await expect(syncSidecarMessages(f.userId, oldRecovery)).rejects.toMatchObject({
      code: "sidecar_save_conflict",
    });
    expect((await f.rows()).map((row) => row.content)).toEqual([
      "legacy question",
      "legacy answer",
    ]);
    // A known receipt still acknowledges an old disk record before baseline validation.
    expect(await syncSidecarMessages(f.userId, { ...legacy, recovery: true })).toMatchObject({
      replayed: true,
    });
  } finally {
    await f.close();
  }
});

test("an unacknowledged pending save cannot recreate a message deleted in another session", async () => {
  const f = await fixture();
  try {
    const saved = await syncSidecarMessages(f.userId, f.input);
    const pending = request(
      {
        ...f.input,
        expectedUserToken: saved.saveTokens?.user,
        expectedAssistantToken: saved.saveTokens?.assistant,
      },
      "unconfirmed pending",
    );
    await db.delete(messages).where(eq(messages.id, saved.assistantMessageId));
    await expect(
      syncSidecarMessages(f.userId, { ...pending, recovery: true }),
    ).rejects.toMatchObject({ code: "sidecar_save_conflict" });
    expect((await f.rows()).map((row) => row.role)).toEqual(["user"]);
  } finally {
    await f.close();
  }
});

test("HTTP save conflicts are structured 409 responses and listed tokens reflect the winning write", () => {
  const child = Bun.spawnSync(
    [
      process.execPath,
      new URL("./messageService.sidecar-cas.fixture.ts", import.meta.url).pathname,
    ],
    { env: { ...process.env, NODE_ENV: "test" }, stdout: "pipe", stderr: "pipe", timeout: 15_000 },
  );
  expect(child.exitCode).toBe(0);
  expect(JSON.parse(child.stdout.toString())).toEqual({
    first: 200,
    newer: 200,
    conflict: 409,
    errorCode: "sidecar_save_conflict",
    content: "newer",
    tokensMatch: true,
  });
});
