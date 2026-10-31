import { expect, test } from "bun:test";
import { conversations, messages, users } from "db";
import { eq } from "drizzle-orm";
import { client, db } from "./index";
import { settleServerAgentTasks } from "./settleServerAgentTasks";

async function seed(userId: string, conversationId: string, runStatus: string | null) {
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
    title: "settle",
    contextLength: 4096,
    runStatus,
    createdAt,
    updatedAt: createdAt,
  });
}

async function cleanup(userId: string, conversationId: string) {
  await client.execute({ sql: "DELETE FROM agent_tasks WHERE user_id = ?", args: [userId] });
  await db.delete(messages).where(eq(messages.conversationId, conversationId));
  await db.delete(conversations).where(eq(conversations.id, conversationId));
  await db.delete(users).where(eq(users.id, userId));
}

async function seedTask(
  userId: string,
  conversationId: string,
  id: string,
  status: string,
  run: { phase: string; status: string },
  approval?: string,
) {
  const now = Math.floor(Date.now() / 1000);
  await client.execute({
    sql: `INSERT INTO agent_tasks (id, user_id, conversation_id, title, goal, status, created_at, updated_at)
          VALUES (?, ?, ?, 't', 'g', ?, ?, ?)`,
    args: [id, userId, conversationId, status, now, now],
  });
  await client.execute({
    sql: `INSERT INTO agent_runs (id, task_id, phase, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)`,
    args: [`${id}-run`, id, run.phase, run.status, now, now],
  });
  if (approval) {
    await client.execute({
      sql: `INSERT INTO agent_approval_requests
              (id, task_id, run_id, type, status, title, requested_at, created_at, updated_at)
            VALUES (?, ?, ?, 'plan_approval', ?, 'a', ?, ?, ?)`,
      args: [`${id}-approval`, id, `${id}-run`, approval, now, now, now],
    });
  }
}

async function scalar(sql: string, args: string[]) {
  const result = await client.execute({ sql, args });
  return result.rows[0]?.[0] ?? null;
}

test("settles stuck server agent turns without touching reply text", async () => {
  const userId = crypto.randomUUID();
  const conversationId = crypto.randomUUID();
  const tasks = {
    draft: crypto.randomUUID(),
    awaiting: crypto.randomUUID(),
    done: crypto.randomUUID(),
  };
  const ids = {
    awaiting: crypto.randomUUID(),
    draftShownDone: crypto.randomUUID(),
    doneStaleTag: crypto.randomUUID(),
    goneRunning: crypto.randomUUID(),
    goneDone: crypto.randomUUID(),
    sidecar: crypto.randomUUID(),
  };
  try {
    await seed(userId, conversationId, "awaiting_approval");
    await seedTask(
      userId,
      conversationId,
      tasks.draft,
      "draft",
      { phase: "planning", status: "completed" },
      "approved",
    );
    await seedTask(
      userId,
      conversationId,
      tasks.awaiting,
      "awaiting_approval",
      { phase: "planning", status: "awaiting_approval" },
      "pending",
    );
    await seedTask(userId, conversationId, tasks.done, "completed", {
      phase: "execution",
      status: "completed",
    });

    const base = { conversationId, role: "assistant", mode: "agent", createdAt: new Date() };
    const textRun = { steps: [{ type: "text", content: "kept answer" }] };
    await db.insert(messages).values([
      {
        ...base,
        id: ids.awaiting,
        content: "",
        agentRun: JSON.stringify({
          status: "awaiting_approval",
          steps: [],
          taskId: tasks.awaiting,
          taskStatus: "awaiting_approval",
        }),
      },
      {
        ...base,
        id: ids.draftShownDone,
        content: "",
        agentRun: JSON.stringify({
          status: "completed",
          steps: [],
          taskId: tasks.draft,
          taskStatus: "draft",
        }),
      },
      {
        ...base,
        id: ids.doneStaleTag,
        content: "kept answer",
        agentRun: JSON.stringify({
          status: "completed",
          ...textRun,
          taskId: tasks.done,
          taskStatus: "draft",
        }),
      },
      {
        ...base,
        id: ids.goneRunning,
        content: "",
        agentRun: JSON.stringify({ status: "running", steps: [], taskId: crypto.randomUUID() }),
      },
      {
        ...base,
        id: ids.goneDone,
        content: "kept answer",
        agentRun: JSON.stringify({ status: "completed", ...textRun, taskId: "gone" }),
      },
      {
        ...base,
        id: ids.sidecar,
        content: "kept answer",
        agentRun: JSON.stringify({ status: "running", ...textRun }),
      },
    ]);
    const before = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conversationId));

    await settleServerAgentTasks();

    const taskStatus = (id: string) => scalar("SELECT status FROM agent_tasks WHERE id = ?", [id]);
    expect(await taskStatus(tasks.draft)).toBe("cancelled");
    expect(await taskStatus(tasks.awaiting)).toBe("cancelled");
    expect(await taskStatus(tasks.done)).toBe("completed");
    expect(
      await scalar("SELECT status FROM agent_runs WHERE id = ?", [`${tasks.awaiting}-run`]),
    ).toBe("cancelled");
    expect(
      await scalar("SELECT status FROM agent_approval_requests WHERE id = ?", [
        `${tasks.awaiting}-approval`,
      ]),
    ).toBe("rejected");
    expect(
      await scalar("SELECT status FROM agent_approval_requests WHERE id = ?", [
        `${tasks.draft}-approval`,
      ]),
    ).toBe("approved");
    expect(
      await scalar("SELECT run_status FROM conversations WHERE id = ?", [conversationId]),
    ).toBe(null);

    const after = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conversationId));
    const runOf = (id: string) =>
      JSON.parse(after.find((row) => row.id === id)?.agentRun ?? "null") as Record<string, unknown>;
    expect(runOf(ids.awaiting)).toMatchObject({ status: "cancelled", taskStatus: "cancelled" });
    expect(runOf(ids.draftShownDone)).toMatchObject({
      status: "cancelled",
      taskStatus: "cancelled",
    });
    expect(runOf(ids.doneStaleTag)).toMatchObject({
      status: "completed",
      taskStatus: "completed",
      ...textRun,
    });
    expect(runOf(ids.goneRunning)).toMatchObject({ status: "cancelled" });
    // A finished run whose task is gone, and a sidecar run, are left exactly as they were.
    for (const id of [ids.goneDone, ids.sidecar]) {
      expect(after.find((row) => row.id === id)).toEqual(before.find((row) => row.id === id));
    }
    // Content is never rewritten.
    for (const row of after) {
      expect(row.content).toBe(before.find((prev) => prev.id === row.id)?.content ?? "missing");
    }

    // Idempotent: a second pass changes no message.
    expect(await settleServerAgentTasks()).toBe(0);
  } finally {
    await cleanup(userId, conversationId);
  }
});

test("one-time migrations run once per database, tracked by user_version", async () => {
  const { runOneTimeMigrations } = await import("./bootstrap");
  const userId = crypto.randomUUID();
  const conversationId = crypto.randomUUID();
  const firstTask = crypto.randomUUID();
  const laterTask = crypto.randomUUID();
  const original = Number(
    (await client.execute("PRAGMA user_version;")).rows[0]?.user_version ?? 0,
  );
  try {
    await seed(userId, conversationId, null);
    await seedTask(userId, conversationId, firstTask, "draft", {
      phase: "planning",
      status: "completed",
    });
    await client.execute("PRAGMA user_version = 0;");

    await runOneTimeMigrations();
    const version = Number((await client.execute("PRAGMA user_version;")).rows[0]?.user_version);
    expect(version >= 2).toBe(true);
    expect(await scalar("SELECT status FROM agent_tasks WHERE id = ?", [firstTask])).toBe(
      "cancelled",
    );

    // Already applied: a later boot does not run the settle pass again.
    await seedTask(userId, conversationId, laterTask, "draft", {
      phase: "planning",
      status: "completed",
    });
    await runOneTimeMigrations();
    expect(await scalar("SELECT status FROM agent_tasks WHERE id = ?", [laterTask])).toBe("draft");
  } finally {
    await client.execute(`PRAGMA user_version = ${Math.max(original, 2)};`);
    await cleanup(userId, conversationId);
  }
});
