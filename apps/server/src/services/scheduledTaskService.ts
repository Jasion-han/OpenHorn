import { scheduledTaskRuns, scheduledTasks } from "db";
import { and, desc, eq, lte } from "drizzle-orm";
import type { ScheduledTaskFrequency } from "shared/types";
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

export async function listScheduledTasks(userId: string) {
  return db
    .select()
    .from(scheduledTasks)
    .where(eq(scheduledTasks.userId, userId))
    .orderBy(desc(scheduledTasks.createdAt));
}

export async function getScheduledTask(userId: string, taskId: string) {
  const rows = await db
    .select()
    .from(scheduledTasks)
    .where(and(eq(scheduledTasks.id, taskId), eq(scheduledTasks.userId, userId)));
  return rows[0] ?? null;
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
  },
) {
  const now = new Date();
  const id = generateId();
  const nextRunAt = computeNextRunAt(data.frequency, data.time);

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
      ...data,
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
    .where(and(eq(scheduledTasks.enabled, true), lte(scheduledTasks.nextRunAt, now)));
}

export async function createTaskRun(taskId: string, userId: string, conversationId?: string) {
  const id = generateId();
  const now = new Date();
  await db.insert(scheduledTaskRuns).values({
    id,
    taskId,
    userId,
    status: "running",
    conversationId: conversationId ?? null,
    startedAt: now,
  });
  return id;
}

export async function completeTaskRun(
  runId: string,
  result: { status: "completed" | "failed"; result?: string; error?: string },
) {
  const now = new Date();
  await db
    .update(scheduledTaskRuns)
    .set({
      status: result.status,
      result: result.result ?? null,
      error: result.error ?? null,
      completedAt: now,
    })
    .where(eq(scheduledTaskRuns.id, runId));
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
