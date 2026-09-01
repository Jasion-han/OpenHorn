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
      const runId = await createTaskRun(task.id, task.userId);
      try {
        await advanceNextRunAt(task.id);
        await completeTaskRun(runId, {
          status: "completed",
          result: `[定时任务已触发] ${task.title}\n\nPrompt: ${task.prompt}\n\n(Agent 执行功能将在后续版本接入)`,
        });
      } catch (err) {
        await completeTaskRun(runId, {
          status: "failed",
          error: err instanceof Error ? err.message : "Unknown error",
        });
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
