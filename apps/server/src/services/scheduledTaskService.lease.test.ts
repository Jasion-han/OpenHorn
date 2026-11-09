import { expect, test } from "bun:test";
import { scheduledTaskRuns, scheduledTasks, users } from "db";
import { eq } from "drizzle-orm";
import { db } from "../db";
import {
  claimTaskRun,
  createScheduledTask,
  createTaskRun,
  finishTaskRun,
  heartbeatTaskRun,
  listPendingTaskRuns,
  reconcileExpiredTaskRuns,
} from "./scheduledTaskService";

const owner = "synthetic-owner-0000000001";
const other = "synthetic-owner-0000000002";
async function fixture() {
  const id = crypto.randomUUID();
  const now = new Date();
  await db
    .insert(users)
    .values({ id, email: `${id}@test.local`, username: "lease", createdAt: now, updatedAt: now });
  const task = await createScheduledTask(id, {
    title: "Synthetic",
    prompt: "No model",
    frequency: "daily",
    time: "09:00",
  });
  if (!task) throw new Error("Missing fixture task");
  return {
    id,
    task,
    async cleanup() {
      await db.delete(scheduledTaskRuns).where(eq(scheduledTaskRuns.userId, id));
      await db.delete(scheduledTasks).where(eq(scheduledTasks.userId, id));
      await db.delete(users).where(eq(users.id, id));
    },
  };
}

test("a run admits one owner, owner retries are idempotent and terminal writes are fenced", async () => {
  const f = await fixture();
  try {
    const run = await createTaskRun(f.task.id, f.id, undefined, "pending");
    expect(await claimTaskRun(f.id, run, owner)).toBe(true);
    expect(await claimTaskRun(f.id, run, owner)).toBe(true);
    expect(await claimTaskRun(f.id, run, other)).toBe(false);
    expect(await finishTaskRun(f.id, run, { status: "failed" }, other)).toBe(false);
    expect(await finishTaskRun(f.id, run, { status: "completed" }, owner)).toBe(true);
    expect(await finishTaskRun(f.id, run, { status: "failed" }, owner)).toBe(false);
    const rows = await db.select().from(scheduledTaskRuns).where(eq(scheduledTaskRuns.id, run));
    expect(rows[0]?.status).toBe("completed");
  } finally {
    await f.cleanup();
  }
});

test("reconciliation leaves other clients' live runs alone, heartbeat extends only the matching lease", async () => {
  const f = await fixture();
  try {
    const run = await createTaskRun(f.task.id, f.id, undefined, "pending");
    const now = new Date();
    expect(await claimTaskRun(f.id, run, owner, now)).toBe(true);
    expect(await heartbeatTaskRun(f.id, run, other, new Date(now.getTime() + 60_000))).toBe(false);
    expect(await heartbeatTaskRun(f.id, run, owner, new Date(now.getTime() + 60_000))).toBe(true);
    await reconcileExpiredTaskRuns(f.id, new Date(now.getTime() + 130_000));
    let rows = await db.select().from(scheduledTaskRuns).where(eq(scheduledTaskRuns.id, run));
    expect(rows[0]?.status).toBe("running");
    await reconcileExpiredTaskRuns(f.id, new Date(now.getTime() + 181_000));
    rows = await db.select().from(scheduledTaskRuns).where(eq(scheduledTaskRuns.id, run));
    expect(rows[0]?.status).toBe("failed");
    expect(rows[0]?.errorCode).toBe("lease_expired");
    expect(
      await finishTaskRun(
        f.id,
        run,
        { status: "completed" },
        owner,
        new Date(now.getTime() + 181_000),
      ),
    ).toBe(false);
    expect(await heartbeatTaskRun(f.id, run, owner, new Date(now.getTime() + 181_000))).toBe(false);
  } finally {
    await f.cleanup();
  }
});

test("pending queue is independent of the newest 50 historical rows and expires missed runs server-side", async () => {
  const f = await fixture();
  try {
    const pending = await createTaskRun(f.task.id, f.id, undefined, "pending");
    const old = await createTaskRun(f.task.id, f.id, undefined, "pending");
    await db
      .update(scheduledTaskRuns)
      .set({ startedAt: new Date(Date.now() - 16 * 60_000) })
      .where(eq(scheduledTaskRuns.id, old));
    await db.insert(scheduledTaskRuns).values(
      Array.from({ length: 60 }, () => ({
        id: crypto.randomUUID(),
        taskId: f.task.id,
        userId: f.id,
        status: "completed",
        startedAt: new Date(Date.now() + 1_000),
        completedAt: new Date(),
      })),
    );
    await reconcileExpiredTaskRuns(f.id);
    expect((await listPendingTaskRuns(f.id)).map((row) => row.id)).toEqual([pending]);
    expect(await claimTaskRun(f.id, old, owner)).toBe(false);
    const rows = await db.select().from(scheduledTaskRuns).where(eq(scheduledTaskRuns.id, old));
    expect(rows[0]?.errorCode).toBe("missed");
  } finally {
    await f.cleanup();
  }
});
