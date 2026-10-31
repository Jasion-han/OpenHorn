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
  // agent_tasks cascades to its runs / artifacts / events.
  await client.execute({ sql: "DELETE FROM agent_tasks WHERE user_id = ?", args: [userId] });
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

test("sidecar sync stores empty content for a run without text steps (no fallback)", async () => {
  const userId = crypto.randomUUID();
  const conversationId = crypto.randomUUID();
  try {
    await seed(userId, conversationId);
    const { assistantMessageId } = await syncSidecarMessages(userId, {
      conversationId,
      userContent: "question",
      // Older desktop builds sent the error text as the reply.
      assistantContent: "Error: boom",
      agentRun: { status: "failed", summary: "Error", error: "boom", steps: [] },
    });
    expect(await contentOf(assistantMessageId)).toBe("");
  } finally {
    await cleanup(userId, conversationId);
  }
});

// ---------------------------------------------------------------------------
// Legacy task-backed (server-run) turns — settled by the bootstrap backfill
// ---------------------------------------------------------------------------

const LONG_ANSWER = `answer ${"x".repeat(2000)}`;

async function seedTask(
  userId: string,
  conversationId: string,
  task: { id: string; status: string; result?: string; error?: string },
) {
  const now = Date.now();
  await client.execute({
    sql: `INSERT INTO agent_tasks (id, user_id, conversation_id, title, goal, status, created_at, updated_at)
          VALUES (?, ?, ?, 't', 'g', ?, ?, ?)`,
    args: [task.id, userId, conversationId, task.status, now, now],
  });
  const runId = `${task.id}-exec`;
  await client.execute({
    sql: `INSERT INTO agent_runs (id, task_id, phase, status, error, created_at, updated_at)
          VALUES (?, ?, 'execution', ?, ?, ?, ?)`,
    args: [runId, task.id, task.status, task.error ?? null, now, now],
  });
  if (task.result !== undefined) {
    await client.execute({
      sql: `INSERT INTO agent_artifacts (id, task_id, run_id, type, title, content, created_at, updated_at)
            VALUES (?, ?, ?, 'final_result', 'r', ?, ?, ?)`,
      args: [`${task.id}-result`, task.id, runId, task.result, now, now],
    });
  }
}

test("backfill brings every legacy agent row in line with its run, once", async () => {
  const userId = crypto.randomUUID();
  const conversationId = crypto.randomUUID();
  const taskOk = crypto.randomUUID();
  const taskFailed = crypto.randomUUID();
  const ids = {
    empty: crypto.randomUUID(),
    stale: crypto.randomUUID(),
    blankText: crypto.randomUUID(),
    replyInContent: crypto.randomUUID(),
    errorInContent: crypto.randomUUID(),
    failedNoError: crypto.randomUUID(),
    poppedFinal: crypto.randomUUID(),
    concatenated: crypto.randomUUID(),
    failedPartial: crypto.randomUUID(),
    errorWithSteps: crypto.randomUUID(),
    taskOk: crypto.randomUUID(),
    taskFailed: crypto.randomUUID(),
    taskGone: crypto.randomUUID(),
    chat: crypto.randomUUID(),
  };
  try {
    await seed(userId, conversationId);
    await seedTask(userId, conversationId, {
      id: taskOk,
      status: "completed",
      result: LONG_ANSWER,
    });
    await seedTask(userId, conversationId, { id: taskFailed, status: "failed", error: "boom" });
    const base = { conversationId, role: "assistant", mode: "agent", createdAt: new Date() };
    const tools = [{ type: "tool_start", toolName: "Bash" }];
    await db.insert(messages).values([
      { ...base, id: ids.empty, content: "", agentRun: JSON.stringify(run(["蓝鲸42"])) },
      // Text in content that the steps lack is never dropped.
      { ...base, id: ids.stale, content: "kept", agentRun: JSON.stringify(run(["other"])) },
      // Builds before the timeline stream popped the trailing text steps on
      // completion: the preamble stays a step, the answer lives only in content.
      {
        ...base,
        id: ids.poppedFinal,
        content: "the full answer",
        agentRun: JSON.stringify({
          status: "completed",
          steps: [{ type: "text", content: "Let me check." }, ...tools],
        }),
      },
      // ...and content was every streamed segment concatenated.
      {
        ...base,
        id: ids.concatenated,
        content: "Let me check.Found it: 42",
        agentRun: JSON.stringify({
          status: "completed",
          steps: [{ type: "text", content: "Let me check." }, ...tools],
        }),
      },
      // Older failed runs kept the partial reply in content, the error in agentRun.error.
      {
        ...base,
        id: ids.failedPartial,
        content: "partial answer",
        agentRun: JSON.stringify({ status: "failed", error: "timeout", steps: tools }),
      },
      // A failed run with text steps whose content was overwritten by the error.
      {
        ...base,
        id: ids.errorWithSteps,
        content: "timeout",
        agentRun: JSON.stringify({ ...run(["half"]), status: "failed", error: "timeout" }),
      },
      { ...base, id: ids.blankText, content: "", agentRun: JSON.stringify(run(["  "])) },
      // Older desktop builds stripped the text steps and kept the reply in content.
      {
        ...base,
        id: ids.replyInContent,
        content: "the reply",
        agentRun: JSON.stringify({ status: "completed", summary: "Done", steps: tools }),
      },
      // ...and wrote the failure into content.
      {
        ...base,
        id: ids.errorInContent,
        content: "Error: timeout",
        agentRun: JSON.stringify({ status: "failed", error: "timeout", steps: [] }),
      },
      {
        ...base,
        id: ids.failedNoError,
        content: "sidecar connection closed",
        agentRun: JSON.stringify({ status: "failed", steps: [] }),
      },
      {
        ...base,
        id: ids.taskOk,
        content: "answer xxx…",
        agentRun: JSON.stringify({
          status: "completed",
          summary: "answer xxx…",
          steps: [],
          taskId: taskOk,
        }),
      },
      {
        ...base,
        id: ids.taskFailed,
        content: "boom",
        agentRun: JSON.stringify({
          status: "failed",
          summary: "boom",
          steps: [],
          taskId: taskFailed,
        }),
      },
      {
        ...base,
        id: ids.taskGone,
        content: "clipped preview",
        agentRun: JSON.stringify({
          status: "completed",
          summary: "clipped preview",
          steps: [],
          taskId: crypto.randomUUID(),
        }),
      },
      { ...base, id: ids.chat, mode: "chat", content: "chat reply", agentRun: null },
    ]);

    await backfillAgentReplyContent();
    const agentRunOf = async (id: string) => {
      const [row] = await db.select().from(messages).where(eq(messages.id, id));
      return JSON.parse(row?.agentRun ?? "null");
    };

    expect(await contentOf(ids.empty)).toBe("蓝鲸42");
    expect(await ftsContentOf(ids.empty)).toEqual(["蓝鲸42"]);
    expect(await contentOf(ids.stale)).toBe("other\n\nkept");
    expect(await contentOf(ids.poppedFinal)).toBe("Let me check.\n\nthe full answer");
    expect(await ftsContentOf(ids.poppedFinal)).toEqual(["Let me check.\n\nthe full answer"]);
    expect(await contentOf(ids.concatenated)).toBe("Let me check.\n\nFound it: 42");
    expect(await contentOf(ids.failedPartial)).toBe("partial answer");
    expect((await agentRunOf(ids.failedPartial)).error).toBe("timeout");
    expect(await contentOf(ids.errorWithSteps)).toBe("half");
    expect((await agentRunOf(ids.errorWithSteps)).error).toBe("timeout");
    expect(await contentOf(ids.blankText)).toBe("");

    expect(await contentOf(ids.replyInContent)).toBe("the reply");
    expect((await agentRunOf(ids.replyInContent)).steps).toEqual([
      ...tools,
      { type: "text", content: "the reply" },
    ]);

    expect(await contentOf(ids.errorInContent)).toBe("");
    expect(await ftsContentOf(ids.errorInContent)).toEqual([]);
    expect((await agentRunOf(ids.errorInContent)).error).toBe("timeout");
    expect(await contentOf(ids.failedNoError)).toBe("");
    expect((await agentRunOf(ids.failedNoError)).error).toBe("sidecar connection closed");

    expect(await contentOf(ids.taskOk)).toBe(LONG_ANSWER);
    expect(await ftsContentOf(ids.taskOk)).toEqual([LONG_ANSWER]);
    expect((await agentRunOf(ids.taskOk)).steps).toEqual([{ type: "text", content: LONG_ANSWER }]);
    expect((await agentRunOf(ids.taskOk)).summary).toBe("answer xxx…");

    expect(await contentOf(ids.taskFailed)).toBe("");
    expect((await agentRunOf(ids.taskFailed)).error).toBe("boom");

    // Task no longer on record: the stored text is all there is, kept as the reply.
    expect(await contentOf(ids.taskGone)).toBe("clipped preview");
    expect(await contentOf(ids.chat)).toBe("chat reply");

    // Second pass changes nothing anywhere and does not duplicate FTS rows.
    const snapshot = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conversationId));
    await backfillAgentReplyContent();
    const again = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conversationId));
    expect(again).toEqual(snapshot);
    expect(await ftsContentOf(ids.taskOk)).toEqual([LONG_ANSWER]);
  } finally {
    await cleanup(userId, conversationId);
  }
});
