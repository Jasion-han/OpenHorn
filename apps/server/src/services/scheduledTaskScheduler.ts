import { scheduledTaskRuns, scheduledTasks } from "db";
import { and, asc, eq, isNotNull } from "drizzle-orm";
import type { ScheduledTaskFrequency } from "shared/types";
import { db } from "../db";
import { generateId } from "../utils";
import { getResolvedChannelForUser } from "./channelService";
import { createConversation } from "./conversationService";
import { computeNextRunAt, getDueTasks, reconcileExpiredTaskRuns } from "./scheduledTaskService";

let timerHandle: ReturnType<typeof setTimeout> | null = null;
let stopped = true;
let schedulingVersion = 0;
let executing = false;

// Upper bound on one sleep. Mutations re-arm the timer precisely; this only
// guards against changes that bypass the routes (another process, a clock
// jump), at the cost of one indexed SELECT per minute.
const MAX_SLEEP_MS = 60_000;

type DueTask = Awaited<ReturnType<typeof getDueTasks>>[number];

export async function settleDueTask(
  task: DueTask,
  outcome: { channelId: string | null; modelId: string | null } | { error: string },
) {
  const dueAt = task.nextRunAt;
  if (!dueAt || dueAt.getTime() > Date.now()) return false;
  return db.transaction(async (tx) => {
    const now = new Date();
    // A replay (including after an ambiguous commit) no longer owns this occurrence.
    const claimed = await tx
      .update(scheduledTasks)
      .set({
        lastRunAt: now,
        updatedAt: now,
        nextRunAt: computeNextRunAt(task.frequency as ScheduledTaskFrequency, task.time),
      })
      .where(
        and(
          eq(scheduledTasks.id, task.id),
          eq(scheduledTasks.userId, task.userId),
          eq(scheduledTasks.enabled, true),
          eq(scheduledTasks.nextRunAt, dueAt),
        ),
      )
      .returning({ id: scheduledTasks.id });
    if (!claimed.length) return false;
    const base = { id: generateId(), taskId: task.id, userId: task.userId, startedAt: now };
    if ("error" in outcome) {
      await tx
        .insert(scheduledTaskRuns)
        .values({ ...base, status: "failed", error: outcome.error, completedAt: now });
    } else {
      const conversation = await createConversation(
        task.userId,
        {
          title: task.title,
          ...outcome,
          forceNew: true,
          scheduledTaskId: task.id,
          projectId: task.projectId,
        },
        tx,
      );
      await tx
        .insert(scheduledTaskRuns)
        .values({ ...base, status: "pending", conversationId: conversation.id });
    }
    return true;
  });
}

async function executeDueTasks() {
  if (stopped || executing) return;
  executing = true;
  try {
    await reconcileExpiredTaskRuns();
    const dueTasks = await getDueTasks();
    for (const task of dueTasks) {
      try {
        let channelId = task.channelId;
        let modelId = task.modelId;
        if (!channelId) {
          const resolved = await getResolvedChannelForUser(task.userId);
          if (resolved) {
            channelId = resolved.channel.id;
            modelId = resolved.modelId;
          }
        }

        await settleDueTask(task, { channelId, modelId });
      } catch (err) {
        await settleDueTask(task, { error: err instanceof Error ? err.message : String(err) });
        console.error("[scheduler] task failed:", task.id, err);
      }
    }
  } catch {
    // silently retry
  }
  executing = false;
  if (!stopped) void scheduleNext();
}

async function scheduleNext() {
  const version = ++schedulingVersion;
  if (timerHandle) {
    clearTimeout(timerHandle);
    timerHandle = null;
  }

  try {
    const now = new Date();
    const upcoming = await db
      .select({ nextRunAt: scheduledTasks.nextRunAt })
      .from(scheduledTasks)
      // NULL sorts first in SQLite ASC: an enabled task without a nextRunAt
      // would otherwise pin the head of this query and drop the scheduler
      // into the 60s fallback for every real task.
      .where(and(eq(scheduledTasks.enabled, true), isNotNull(scheduledTasks.nextRunAt)))
      .orderBy(asc(scheduledTasks.nextRunAt))
      .limit(1);

    if (stopped || version !== schedulingVersion) return;
    if (upcoming.length === 0 || !upcoming[0].nextRunAt) {
      timerHandle = setTimeout(() => void executeDueTasks(), MAX_SLEEP_MS);
      return;
    }

    const nextTime = upcoming[0].nextRunAt.getTime();
    // Land one second past the due time (timers fire a hair early) and never
    // wait less than a second, so a due task cannot make this spin.
    const delay = Math.max(nextTime - now.getTime() + 1000, 1000);
    const cappedDelay = Math.min(delay, MAX_SLEEP_MS);

    timerHandle = setTimeout(() => void executeDueTasks(), cappedDelay);
  } catch {
    if (stopped || version !== schedulingVersion) return;
    timerHandle = setTimeout(() => void executeDueTasks(), MAX_SLEEP_MS);
  }
}

/**
 * Re-arm after a task was created, edited, toggled, deleted or run manually:
 * the timer is set to the earliest due time known when it was armed, so a
 * task that becomes due sooner would otherwise wait for that (or the cap).
 */
export function rescheduleScheduler() {
  if (!stopped) void scheduleNext();
}

export function startScheduler() {
  stopped = false;
  void executeDueTasks();
}

export function stopScheduler() {
  stopped = true;
  schedulingVersion++;
  if (timerHandle) {
    clearTimeout(timerHandle);
    timerHandle = null;
  }
}
