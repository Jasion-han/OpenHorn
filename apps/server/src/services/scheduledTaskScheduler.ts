import { messages } from "db";
import { db } from "../db";
import { generateId } from "../utils";
import { getResolvedChannelForUser } from "./channelService";
import { createConversation } from "./conversationService";
import {
  advanceNextRunAt,
  completeTaskRun,
  createTaskRun,
  getDueTasks,
} from "./scheduledTaskService";

let intervalHandle: ReturnType<typeof setInterval> | null = null;

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

        await db.insert(messages).values({
          id: generateId(),
          conversationId: conversation.id,
          role: "user",
          content: `[定时任务自动触发] ${task.prompt}`,
          mode: "agent",
          createdAt: new Date(),
        });

        const runId = await createTaskRun(task.id, task.userId, conversation.id);
        await completeTaskRun(runId, { status: "completed" });
        await advanceNextRunAt(task.id);
      } catch (err) {
        const runId = await createTaskRun(task.id, task.userId);
        await completeTaskRun(runId, {
          status: "failed",
          error: err instanceof Error ? err.message : "Unknown error",
        });
        await advanceNextRunAt(task.id);
      }
    }
  } catch {
    // silently retry next interval
  }
}

export function startScheduler() {
  if (intervalHandle) return;
  intervalHandle = setInterval(() => void executeDueTasks(), 60_000);
  void executeDueTasks();
}

export function stopScheduler() {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}
