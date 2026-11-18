import { createHash } from "node:crypto";
import { manualTaskReceipts, scheduledTaskRuns, scheduledTasks } from "db";
import { and, eq } from "drizzle-orm";
import type { ScheduledTaskFrequency } from "shared/types";
import { db } from "../db";
import { generateId } from "../utils";
import { getResolvedChannelForUser } from "./channelService";
import { createConversation } from "./conversationService";
import { computeNextRunAt, getScheduledTask } from "./scheduledTaskService";

const pending = new Map<string, Promise<{ runId: string; conversationId: string } | null>>();
export async function enqueueManualTask(userId: string, taskId: string, requestId: string) {
  const id = createHash("sha256")
    .update(JSON.stringify([userId, taskId, requestId]))
    .digest("hex");
  const active = pending.get(id);
  if (active) return active;
  const operation = writeManualTask(userId, taskId, id);
  pending.set(id, operation);
  try {
    return await operation;
  } finally {
    pending.delete(id);
  }
}

async function writeManualTask(userId: string, taskId: string, id: string) {
  const fields = {
    runId: manualTaskReceipts.runId,
    conversationId: manualTaskReceipts.conversationId,
  };
  const [previous] = await db
    .select(fields)
    .from(manualTaskReceipts)
    .where(eq(manualTaskReceipts.id, id));
  if (previous) return previous;
  const task = await getScheduledTask(userId, taskId);
  if (!task) return null;
  const fallback = task.channelId ? null : await getResolvedChannelForUser(userId);
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select(fields)
      .from(manualTaskReceipts)
      .where(eq(manualTaskReceipts.id, id));
    if (existing) return existing;
    const [current] = await tx
      .select()
      .from(scheduledTasks)
      .where(and(eq(scheduledTasks.userId, userId), eq(scheduledTasks.id, taskId)));
    if (!current) return null;
    const { id: conversationId } = await createConversation(
      userId,
      {
        title: current.title,
        channelId: current.channelId ?? fallback?.channel.id,
        modelId: current.channelId ? current.modelId : fallback?.modelId,
        forceNew: true,
        scheduledTaskId: taskId,
        projectId: current.projectId,
      },
      tx,
    );
    const runId = generateId();
    const now = new Date();
    await tx
      .insert(scheduledTaskRuns)
      .values({ id: runId, taskId, userId, status: "pending", conversationId, startedAt: now });
    await tx
      .update(scheduledTasks)
      .set({
        lastRunAt: now,
        updatedAt: now,
        nextRunAt: current.enabled
          ? computeNextRunAt(current.frequency as ScheduledTaskFrequency, current.time)
          : null,
      })
      .where(eq(scheduledTasks.id, taskId));
    await tx.insert(manualTaskReceipts).values({ id, taskId, runId, conversationId });
    return { runId, conversationId };
  });
}
