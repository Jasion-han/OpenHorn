import { describe, expect, test } from "bun:test";
import { agentTasks, conversations, messages, users } from "db";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { bootstrapDatabase } from "../db/bootstrap";
import { generateId } from "../utils";
import {
  getMessagesForUserWithAttachments,
  isTerminalTaskStatus,
  syncTaskBackedMessages,
} from "./messageService";

async function seedUser() {
  const userId = generateId();
  const now = new Date();
  await db.insert(users).values({
    id: userId,
    email: `${userId}@test.local`,
    username: "tasksync",
    passwordHash: "x",
    createdAt: now,
    updatedAt: now,
  });
  return userId;
}

/** A conversation holding one agent message that points at `taskStatus`. */
async function seedAgentTurn(userId: string, taskStatus: string) {
  const now = new Date();
  const conversationId = generateId();
  const taskId = generateId();
  const messageId = generateId();

  await db.insert(conversations).values({
    id: conversationId,
    userId,
    title: "agent turn",
    contextLength: 4096,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(agentTasks).values({
    id: taskId,
    userId,
    conversationId,
    title: "agent turn",
    goal: "do a thing",
    status: taskStatus,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(messages).values({
    id: messageId,
    conversationId,
    role: "assistant",
    content: "already summarised",
    mode: "agent",
    agentRun: JSON.stringify({
      status: "completed",
      summary: "already summarised",
      steps: [],
      taskId,
      taskStatus,
    }),
    createdAt: now,
  });

  return { conversationId, taskId, messageId };
}

describe("isTerminalTaskStatus", () => {
  test("treats finished states as terminal", () => {
    expect(isTerminalTaskStatus("completed")).toBe(true);
    expect(isTerminalTaskStatus("failed")).toBe(true);
    expect(isTerminalTaskStatus("cancelled")).toBe(true);
  });

  test("treats in-flight states as non-terminal", () => {
    expect(isTerminalTaskStatus("running")).toBe(false);
    expect(isTerminalTaskStatus("planning")).toBe(false);
    expect(isTerminalTaskStatus("awaiting_approval")).toBe(false);
    expect(isTerminalTaskStatus("draft")).toBe(false);
  });

  // Messages written before taskStatus existed must still be synced, not skipped.
  test("an absent status is not terminal", () => {
    expect(isTerminalTaskStatus(undefined)).toBe(false);
  });
});

describe("read path does not re-sync finished agent turns", () => {
  test("opening a conversation of finished turns performs no writes", async () => {
    await bootstrapDatabase();
    const userId = await seedUser();
    const { conversationId, messageId } = await seedAgentTurn(userId, "completed");

    // Corrupt the task so that ANY attempt to re-sync would rewrite the message
    // (the summary rebuilt from task state differs from what is stored).
    await db
      .update(agentTasks)
      .set({ goal: "changed after the fact" })
      .where(eq(agentTasks.conversationId, conversationId));

    await getMessagesForUserWithAttachments(userId, conversationId);

    const [row] = await db.select().from(messages).where(eq(messages.id, messageId));
    // Untouched: the read path skipped the finished task entirely.
    expect(row?.content).toBe("already summarised");
  });
});

describe("syncTaskBackedMessages", () => {
  test("does not rewrite a message whose content is already current", async () => {
    await bootstrapDatabase();
    const userId = await seedUser();
    const { taskId, messageId } = await seedAgentTurn(userId, "running");

    // First sync brings the message in line with the task.
    await syncTaskBackedMessages(userId, taskId);
    const [afterFirst] = await db.select().from(messages).where(eq(messages.id, messageId));
    const contentAfterFirst = afterFirst?.content;
    const runAfterFirst = afterFirst?.agentRun;

    // Second sync has nothing to change and must leave the row exactly as-is.
    await syncTaskBackedMessages(userId, taskId);
    const [afterSecond] = await db.select().from(messages).where(eq(messages.id, messageId));

    expect(afterSecond?.content).toBe(contentAfterFirst as string);
    expect(afterSecond?.agentRun).toBe(runAfterFirst as string);
  });
});
