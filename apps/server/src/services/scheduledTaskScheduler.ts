import { scheduledTasks } from "db";
import { and, asc, eq, isNotNull } from "drizzle-orm";
import { db } from "../db";
import { getResolvedChannelForUser } from "./channelService";
import { createConversation } from "./conversationService";
import {
  advanceNextRunAt,
  createTaskRun,
  finishTaskRun,
  getDueTasks,
} from "./scheduledTaskService";

let timerHandle: ReturnType<typeof setTimeout> | null = null;

// Upper bound on one sleep. Mutations re-arm the timer precisely; this only
// guards against changes that bypass the routes (another process, a clock
// jump), at the cost of one indexed SELECT per minute.
const MAX_SLEEP_MS = 60_000;

async function executeDueTasks() {
  try {
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

        // One conversation per run: never adopt a blank one left by an earlier run.
        const conversation = await createConversation(task.userId, {
          title: task.title,
          channelId,
          modelId,
          forceNew: true,
          scheduledTaskId: task.id,
        });

        // The server is only the clock: it records that the task is due and
        // hands the run to the desktop as `pending`. Execution needs the local
        // sidecar (MCP, skills, workspace), so the desktop claims the run,
        // executes it through the same pipeline as a typed chat message, and
        // reports completed / failed with the result.
        await createTaskRun(task.id, task.userId, conversation.id, "pending");
        await advanceNextRunAt(task.id);
      } catch (err) {
        const runId = await createTaskRun(task.id, task.userId, undefined, "pending");
        await finishTaskRun(task.userId, runId, {
          status: "failed",
          error: err instanceof Error ? err.message : String(err),
        });
        await advanceNextRunAt(task.id);
        console.error("[scheduler] task failed:", task.id, err);
      }
    }
  } catch {
    // silently retry
  }
  scheduleNext();
}

async function scheduleNext() {
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
    timerHandle = setTimeout(() => void executeDueTasks(), MAX_SLEEP_MS);
  }
}

/**
 * Re-arm after a task was created, edited, toggled, deleted or run manually:
 * the timer is set to the earliest due time known when it was armed, so a
 * task that becomes due sooner would otherwise wait for that (or the cap).
 */
export function rescheduleScheduler() {
  void scheduleNext();
}

export function startScheduler() {
  void executeDueTasks();
}

export function stopScheduler() {
  if (timerHandle) {
    clearTimeout(timerHandle);
    timerHandle = null;
  }
}
