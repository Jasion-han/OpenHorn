import { scheduledTasks } from "db";
import { and, asc, eq, lte } from "drizzle-orm";
import { db } from "../db";
import { getResolvedChannelForUser } from "./channelService";
import { createConversation } from "./conversationService";
import {
  advanceNextRunAt,
  completeTaskRun,
  createTaskRun,
  getDueTasks,
} from "./scheduledTaskService";

let timerHandle: ReturnType<typeof setTimeout> | null = null;

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

        const conversation = await createConversation(task.userId, {
          title: task.title,
          channelId,
          modelId,
        });

        const runId = await createTaskRun(task.id, task.userId, conversation.id);
        await completeTaskRun(runId, { status: "completed" });
        await advanceNextRunAt(task.id);
      } catch (err) {
        const runId = await createTaskRun(task.id, task.userId);
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
      .where(and(eq(scheduledTasks.enabled, true)))
      .orderBy(asc(scheduledTasks.nextRunAt))
      .limit(1);

    if (upcoming.length === 0 || !upcoming[0].nextRunAt) {
      timerHandle = setTimeout(() => void executeDueTasks(), 60_000);
      return;
    }

    const nextTime = upcoming[0].nextRunAt.getTime();
    const delay = Math.max(nextTime - now.getTime() + 1000, 5000);
    const cappedDelay = Math.min(delay, 3600_000);

    timerHandle = setTimeout(() => void executeDueTasks(), cappedDelay);
  } catch {
    timerHandle = setTimeout(() => void executeDueTasks(), 60_000);
  }
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
