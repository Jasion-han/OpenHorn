import { projects, scheduledTaskRuns, scheduledTasks } from "db";
import { and, asc, desc, eq, gt, isNull, lte, or } from "drizzle-orm";
import type { FrozenRecipeSnapshot, ScheduledTaskFrequency } from "shared/types";
import { db } from "../db";
import { generateId } from "../utils";

export function computeNextRunAt(frequency: ScheduledTaskFrequency, time: string): Date {
  const [hours, minutes] = time.split(":").map(Number);
  const now = new Date();
  const candidate = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    hours,
    minutes,
    0,
    0,
  );

  if (frequency === "daily") {
    if (candidate.getTime() <= now.getTime()) {
      candidate.setDate(candidate.getDate() + 1);
    }
    return candidate;
  }

  const dayMap: Record<string, number> = {
    weekly_sun: 0,
    weekly_mon: 1,
    weekly_tue: 2,
    weekly_wed: 3,
    weekly_thu: 4,
    weekly_fri: 5,
    weekly_sat: 6,
  };
  const targetDay = dayMap[frequency];
  if (targetDay === undefined) return candidate;

  const currentDay = candidate.getDay();
  let daysAhead = targetDay - currentDay;
  if (daysAhead < 0) daysAhead += 7;
  if (daysAhead === 0 && candidate.getTime() <= now.getTime()) daysAhead = 7;
  candidate.setDate(candidate.getDate() + daysAhead);
  return candidate;
}

function taskWithSnapshot(row: typeof scheduledTasks.$inferSelect) {
  return {
    ...row,
    recipeSnapshot: row.recipeSnapshot
      ? (JSON.parse(row.recipeSnapshot) as FrozenRecipeSnapshot)
      : undefined,
  };
}

export async function listScheduledTasks(userId: string) {
  return db
    .select()
    .from(scheduledTasks)
    .where(eq(scheduledTasks.userId, userId))
    .orderBy(desc(scheduledTasks.createdAt))
    .then((rows) => rows.map(taskWithSnapshot));
}

export async function getScheduledTask(userId: string, taskId: string) {
  const rows = await db
    .select()
    .from(scheduledTasks)
    .where(and(eq(scheduledTasks.id, taskId), eq(scheduledTasks.userId, userId)));
  return rows[0] ? taskWithSnapshot(rows[0]) : null;
}

export async function createScheduledTask(
  userId: string,
  data: {
    title: string;
    prompt: string;
    frequency: ScheduledTaskFrequency;
    time: string;
    notifyOnComplete?: boolean;
    channelId?: string;
    modelId?: string;
    projectId?: string;
    recipeSnapshot?: FrozenRecipeSnapshot;
  },
  id = generateId(),
) {
  const now = new Date();
  const nextRunAt = computeNextRunAt(data.frequency, data.time);
  if (data.projectId) {
    const [project] = await db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.id, data.projectId), eq(projects.userId, userId)))
      .limit(1);
    if (!project) throw new Error("Project not found");
  }

  await db.insert(scheduledTasks).values({
    id,
    userId,
    title: data.title,
    prompt: data.prompt,
    frequency: data.frequency,
    time: data.time,
    enabled: true,
    notifyOnComplete: data.notifyOnComplete ?? true,
    channelId: data.channelId ?? null,
    modelId: data.modelId ?? null,
    projectId: data.projectId ?? null,
    recipeSnapshot: data.recipeSnapshot ? JSON.stringify(data.recipeSnapshot) : null,
    nextRunAt,
    createdAt: now,
    updatedAt: now,
  });

  return getScheduledTask(userId, id);
}

export async function updateScheduledTask(
  userId: string,
  taskId: string,
  data: Partial<{
    title: string;
    prompt: string;
    frequency: ScheduledTaskFrequency;
    time: string;
    notifyOnComplete: boolean;
    channelId: string | null;
    modelId: string | null;
  }>,
) {
  const existing = await getScheduledTask(userId, taskId);
  if (!existing) return null;
  if (existing.recipeSnapshot) {
    for (const field of ["prompt", "channelId", "modelId", "projectId"] as const) {
      if (Object.hasOwn(data, field) && (data[field] ?? null) !== (existing[field] ?? null)) {
        throw new Error("Recipe execution snapshot is immutable; create a new schedule");
      }
    }
  }

  const now = new Date();
  const frequency = (data.frequency as ScheduledTaskFrequency) ?? existing.frequency;
  const time = data.time ?? existing.time;
  const nextRunAt =
    data.frequency || data.time
      ? computeNextRunAt(frequency as ScheduledTaskFrequency, time)
      : undefined;

  await db
    .update(scheduledTasks)
    .set({
      ...(data.title !== undefined ? { title: data.title } : {}),
      ...(data.prompt !== undefined ? { prompt: data.prompt } : {}),
      ...(data.frequency !== undefined ? { frequency: data.frequency } : {}),
      ...(data.time !== undefined ? { time: data.time } : {}),
      ...(data.notifyOnComplete !== undefined ? { notifyOnComplete: data.notifyOnComplete } : {}),
      ...(data.channelId !== undefined ? { channelId: data.channelId } : {}),
      ...(data.modelId !== undefined ? { modelId: data.modelId } : {}),
      ...(nextRunAt ? { nextRunAt } : {}),
      updatedAt: now,
    })
    .where(and(eq(scheduledTasks.id, taskId), eq(scheduledTasks.userId, userId)));

  return getScheduledTask(userId, taskId);
}

export async function deleteScheduledTask(userId: string, taskId: string) {
  await db
    .delete(scheduledTasks)
    .where(and(eq(scheduledTasks.id, taskId), eq(scheduledTasks.userId, userId)));
}

export async function toggleScheduledTask(userId: string, taskId: string) {
  const existing = await getScheduledTask(userId, taskId);
  if (!existing) return null;

  const enabled = !existing.enabled;
  const now = new Date();
  const nextRunAt = enabled
    ? computeNextRunAt(existing.frequency as ScheduledTaskFrequency, existing.time)
    : null;

  await db
    .update(scheduledTasks)
    .set({ enabled, nextRunAt, updatedAt: now })
    .where(and(eq(scheduledTasks.id, taskId), eq(scheduledTasks.userId, userId)));

  return getScheduledTask(userId, taskId);
}

export async function listTaskRuns(userId: string, taskId?: string, limit = 50) {
  const baseQuery = db
    .select({
      id: scheduledTaskRuns.id,
      taskId: scheduledTaskRuns.taskId,
      userId: scheduledTaskRuns.userId,
      status: scheduledTaskRuns.status,
      conversationId: scheduledTaskRuns.conversationId,
      result: scheduledTaskRuns.result,
      error: scheduledTaskRuns.error,
      errorCode: scheduledTaskRuns.errorCode,
      leaseExpiresAt: scheduledTaskRuns.leaseExpiresAt,
      startedAt: scheduledTaskRuns.startedAt,
      completedAt: scheduledTaskRuns.completedAt,
      taskTitle: scheduledTasks.title,
    })
    .from(scheduledTaskRuns)
    .leftJoin(scheduledTasks, eq(scheduledTaskRuns.taskId, scheduledTasks.id));

  if (taskId) {
    return baseQuery
      .where(and(eq(scheduledTaskRuns.taskId, taskId), eq(scheduledTaskRuns.userId, userId)))
      .orderBy(desc(scheduledTaskRuns.startedAt))
      .limit(limit);
  }
  return baseQuery
    .where(eq(scheduledTaskRuns.userId, userId))
    .orderBy(desc(scheduledTaskRuns.startedAt))
    .limit(limit);
}

export async function getDueTasks() {
  const now = new Date();
  return db
    .select()
    .from(scheduledTasks)
    .where(and(eq(scheduledTasks.enabled, true), lte(scheduledTasks.nextRunAt, now)))
    .then((rows) => rows.map(taskWithSnapshot));
}

export async function createTaskRun(
  taskId: string,
  userId: string,
  conversationId?: string,
  status: "pending" | "running" = "pending",
) {
  const id = generateId();
  const now = new Date();
  await db.insert(scheduledTaskRuns).values({
    id,
    taskId,
    userId,
    status,
    conversationId: conversationId ?? null,
    startedAt: now,
  });
  return id;
}

export const TASK_RUN_LEASE_MS = 120_000;
const PENDING_RUN_MAX_AGE_MS = 15 * 60_000;

export function isTaskRunOwnerToken(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{16,128}$/.test(value);
}

/** Owner retries are idempotent, but another client cannot acquire a live run. */
export async function claimTaskRun(
  userId: string,
  runId: string,
  ownerToken?: string,
  now = new Date(),
): Promise<boolean> {
  if (!isTaskRunOwnerToken(ownerToken)) return false;
  const result = await db
    .update(scheduledTaskRuns)
    .set({
      status: "running",
      ownerToken,
      leaseExpiresAt: new Date(now.getTime() + TASK_RUN_LEASE_MS),
    })
    .where(
      and(
        eq(scheduledTaskRuns.id, runId),
        eq(scheduledTaskRuns.userId, userId),
        or(
          and(
            eq(scheduledTaskRuns.status, "pending"),
            gt(scheduledTaskRuns.startedAt, new Date(now.getTime() - PENDING_RUN_MAX_AGE_MS)),
          ),
          and(
            eq(scheduledTaskRuns.status, "running"),
            eq(scheduledTaskRuns.ownerToken, ownerToken),
            gt(scheduledTaskRuns.leaseExpiresAt, now),
          ),
        ),
      ),
    );
  return result.rowsAffected > 0;
}

export async function heartbeatTaskRun(
  userId: string,
  runId: string,
  ownerToken: string,
  now = new Date(),
): Promise<boolean> {
  if (!isTaskRunOwnerToken(ownerToken)) return false;
  const result = await db
    .update(scheduledTaskRuns)
    .set({ leaseExpiresAt: new Date(now.getTime() + TASK_RUN_LEASE_MS) })
    .where(
      and(
        eq(scheduledTaskRuns.id, runId),
        eq(scheduledTaskRuns.userId, userId),
        eq(scheduledTaskRuns.status, "running"),
        eq(scheduledTaskRuns.ownerToken, ownerToken),
        gt(scheduledTaskRuns.leaseExpiresAt, now),
      ),
    );
  return result.rowsAffected > 0;
}

/** A fenced terminal write cannot change a completed/failed run or a lost lease. */
export async function finishTaskRun(
  userId: string,
  runId: string,
  result: { status: "completed" | "failed"; result?: string; error?: string },
  ownerToken?: string,
  now = new Date(),
): Promise<boolean> {
  if (!isTaskRunOwnerToken(ownerToken)) return false;
  const updated = await db
    .update(scheduledTaskRuns)
    .set({
      status: result.status,
      result: result.result ?? null,
      error: result.error ?? null,
      errorCode: null,
      completedAt: now,
      leaseExpiresAt: null,
    })
    .where(
      and(
        eq(scheduledTaskRuns.id, runId),
        eq(scheduledTaskRuns.userId, userId),
        eq(scheduledTaskRuns.status, "running"),
        eq(scheduledTaskRuns.ownerToken, ownerToken),
        gt(scheduledTaskRuns.leaseExpiresAt, now),
      ),
    );
  if (updated.rowsAffected > 0) return true;
  // A lost HTTP ACK may repeat the same completion, but can never change it.
  const [settled] = await db
    .select()
    .from(scheduledTaskRuns)
    .where(
      and(
        eq(scheduledTaskRuns.id, runId),
        eq(scheduledTaskRuns.userId, userId),
        eq(scheduledTaskRuns.ownerToken, ownerToken),
        eq(scheduledTaskRuns.status, result.status),
        isNull(scheduledTaskRuns.errorCode),
      ),
    )
    .limit(1);
  return (
    !!settled &&
    settled.result === (result.result ?? null) &&
    settled.error === (result.error ?? null)
  );
}

/** Only server-side preparation failures may settle an unclaimed run. */
export async function failPendingTaskRun(
  userId: string,
  runId: string,
  error: string,
): Promise<void> {
  await db
    .update(scheduledTaskRuns)
    .set({ status: "failed", error, completedAt: new Date() })
    .where(
      and(
        eq(scheduledTaskRuns.id, runId),
        eq(scheduledTaskRuns.userId, userId),
        eq(scheduledTaskRuns.status, "pending"),
      ),
    );
}

/** The queue is not a truncated page of history. It never returns owner tokens. */
export async function listPendingTaskRuns(userId: string) {
  return db
    .select({
      id: scheduledTaskRuns.id,
      taskId: scheduledTaskRuns.taskId,
      userId: scheduledTaskRuns.userId,
      status: scheduledTaskRuns.status,
      conversationId: scheduledTaskRuns.conversationId,
      result: scheduledTaskRuns.result,
      error: scheduledTaskRuns.error,
      errorCode: scheduledTaskRuns.errorCode,
      leaseExpiresAt: scheduledTaskRuns.leaseExpiresAt,
      startedAt: scheduledTaskRuns.startedAt,
      completedAt: scheduledTaskRuns.completedAt,
    })
    .from(scheduledTaskRuns)
    .where(and(eq(scheduledTaskRuns.userId, userId), eq(scheduledTaskRuns.status, "pending")))
    .orderBy(asc(scheduledTaskRuns.startedAt))
    .limit(100);
}

/** Expiry only fails abandoned runs; it never replays possibly completed tools. */
export async function reconcileExpiredTaskRuns(userId?: string, now = new Date()): Promise<void> {
  const scope = userId ? [eq(scheduledTaskRuns.userId, userId)] : [];
  await db
    .update(scheduledTaskRuns)
    .set({
      status: "failed",
      error: null,
      errorCode: "lease_expired",
      completedAt: now,
      leaseExpiresAt: null,
    })
    .where(
      and(
        ...scope,
        eq(scheduledTaskRuns.status, "running"),
        or(
          lte(scheduledTaskRuns.leaseExpiresAt, now),
          and(
            isNull(scheduledTaskRuns.leaseExpiresAt),
            lte(scheduledTaskRuns.startedAt, new Date(now.getTime() - TASK_RUN_LEASE_MS)),
          ),
        ),
      ),
    );
  await db
    .update(scheduledTaskRuns)
    .set({
      status: "failed",
      error: null,
      errorCode: "missed",
      completedAt: now,
    })
    .where(
      and(
        ...scope,
        eq(scheduledTaskRuns.status, "pending"),
        lte(scheduledTaskRuns.startedAt, new Date(now.getTime() - PENDING_RUN_MAX_AGE_MS)),
      ),
    );
}

export async function deleteTaskRun(userId: string, runId: string) {
  await db
    .delete(scheduledTaskRuns)
    .where(and(eq(scheduledTaskRuns.id, runId), eq(scheduledTaskRuns.userId, userId)));
}

export async function advanceNextRunAt(taskId: string) {
  const rows = await db.select().from(scheduledTasks).where(eq(scheduledTasks.id, taskId));
  const task = rows[0];
  if (!task) return;

  const now = new Date();
  const nextRunAt = computeNextRunAt(task.frequency as ScheduledTaskFrequency, task.time);

  await db
    .update(scheduledTasks)
    .set({ lastRunAt: now, nextRunAt, updatedAt: now })
    .where(eq(scheduledTasks.id, taskId));
}
