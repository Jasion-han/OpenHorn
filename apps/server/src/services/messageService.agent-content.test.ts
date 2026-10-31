import { expect, test } from "bun:test";
import { conversations, messages, users } from "db";
import { eq } from "drizzle-orm";
import { client, db } from "../db";
import { backfillAgentReplyContent } from "../db/bootstrap";
import { syncSidecarMessages } from "./messageService";

/**
 * An agent reply's `content` must equal its agentRun text steps: search,
 * export, summaries and history only read `content`. These cover the sidecar
 * write path and the backfill for rows stored before the invariant existed.
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
    title: "agent content",
    contextLength: 4096,
    defaultMode: "agent",
    lastMode: "agent",
    isPinned: false,
    forceWebSearch: true,
    createdAt,
    updatedAt: createdAt,
  });
}

async function cleanup(userId: string, conversationId: string) {
  await client.execute({
    sql: "DELETE FROM messages_fts WHERE conversation_id = ?",
    args: [conversationId],
  });
  await db.delete(messages).where(eq(messages.conversationId, conversationId));
  await db.delete(conversations).where(eq(conversations.id, conversationId));
  await db.delete(users).where(eq(users.id, userId));
}

const run = (texts: string[]) => ({
  status: "completed",
  summary: "Done",
  steps: [
    { type: "reasoning", content: "plan" },
    ...texts.map((content) => ({ type: "text", content })),
  ],
});

async function contentOf(id: string) {
  const [row] = await db.select().from(messages).where(eq(messages.id, id));
  return row?.content;
}

async function ftsContentOf(id: string) {
  const result = await client.execute({
    sql: "SELECT content FROM messages_fts WHERE message_id = ?",
    args: [id],
  });
  return result.rows.map((row) => String(row.content));
}

test("sidecar sync derives content from the run's text steps", async () => {
  const userId = crypto.randomUUID();
  const conversationId = crypto.randomUUID();
  try {
    await seed(userId, conversationId);
    const first = await syncSidecarMessages(userId, {
      conversationId,
      userContent: "question",
      assistantContent: "",
      agentRun: run(["first", "second"]),
    });
    expect(await contentOf(first.assistantMessageId)).toBe("first\n\nsecond");
    expect(await ftsContentOf(first.assistantMessageId)).toEqual(["first\n\nsecond"]);

    // In-place update (edit / regenerate) follows the same rule.
    await syncSidecarMessages(userId, {
      conversationId,
      userContent: "question",
      assistantContent: "stale",
      agentRun: run(["regenerated"]),
      userMessageId: first.userMessageId,
      assistantMessageId: first.assistantMessageId,
    });
    expect(await contentOf(first.assistantMessageId)).toBe("regenerated");
  } finally {
    await cleanup(userId, conversationId);
  }
});

test("sidecar sync keeps the given content when the run has no text steps", async () => {
  const userId = crypto.randomUUID();
  const conversationId = crypto.randomUUID();
  try {
    await seed(userId, conversationId);
    const { assistantMessageId } = await syncSidecarMessages(userId, {
      conversationId,
      userContent: "question",
      assistantContent: "",
      agentRun: { status: "failed", summary: "Error", error: "boom", steps: [] },
    });
    expect(await contentOf(assistantMessageId)).toBe("");
  } finally {
    await cleanup(userId, conversationId);
  }
});

test("backfill fills empty agent replies from text steps, once", async () => {
  const userId = crypto.randomUUID();
  const conversationId = crypto.randomUUID();
  const ids = {
    empty: crypto.randomUUID(),
    filled: crypto.randomUUID(),
    noText: crypto.randomUUID(),
    blankText: crypto.randomUUID(),
  };
  try {
    await seed(userId, conversationId);
    const base = { conversationId, role: "assistant", mode: "agent", createdAt: new Date() };
    await db.insert(messages).values([
      { ...base, id: ids.empty, content: "", agentRun: JSON.stringify(run(["蓝鲸42"])) },
      { ...base, id: ids.filled, content: "kept", agentRun: JSON.stringify(run(["other"])) },
      {
        ...base,
        id: ids.noText,
        content: "",
        agentRun: JSON.stringify({ status: "failed", error: "x", steps: [] }),
      },
      { ...base, id: ids.blankText, content: "", agentRun: JSON.stringify(run(["  "])) },
    ]);

    await backfillAgentReplyContent();
    expect(await contentOf(ids.empty)).toBe("蓝鲸42");
    expect(await ftsContentOf(ids.empty)).toEqual(["蓝鲸42"]);
    expect(await contentOf(ids.filled)).toBe("kept");
    expect(await contentOf(ids.noText)).toBe("");
    expect(await contentOf(ids.blankText)).toBe("");

    // Second pass touches nothing and does not duplicate the FTS row.
    await backfillAgentReplyContent();
    expect(await contentOf(ids.empty)).toBe("蓝鲸42");
    expect(await ftsContentOf(ids.empty)).toEqual(["蓝鲸42"]);
  } finally {
    await cleanup(userId, conversationId);
  }
});
