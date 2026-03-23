import { expect, test } from "bun:test";
import { agentSessions, agentTasks, channels, conversations, users } from "db";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { encrypt } from "../utils";
import { deleteChannel } from "./channelService";

test("deleteChannel clears conversation and agent session references before delete", async () => {
  const userId = crypto.randomUUID();
  const channelId = crypto.randomUUID();
  const conversationId = crypto.randomUUID();
  const sessionId = crypto.randomUUID();
  const taskId = crypto.randomUUID();
  const now = new Date();

  await db.insert(users).values({
    id: userId,
    email: `${userId}@test.local`,
    username: "u",
    passwordHash: "x",
    createdAt: now,
    updatedAt: now,
  });

  await db.insert(channels).values({
    id: channelId,
    userId,
    name: "c",
    provider: "openai",
    apiKey: encrypt("k"),
    baseUrl: "https://relay.example.com/v1",
    model: null,
    enabled: true,
    isDefault: false,
    createdAt: now,
    updatedAt: now,
  });

  await db.insert(conversations).values({
    id: conversationId,
    userId,
    channelId,
    modelId: "gpt-5.2",
    title: "conv",
    systemPrompt: null,
    contextLength: 4096,
    defaultMode: "agent",
    lastMode: "agent",
    isPinned: false,
    forceWebSearch: true,
    runStatus: null,
    workspaceId: null,
    createdAt: now,
    updatedAt: now,
  });

  await db.insert(agentSessions).values({
    id: sessionId,
    userId,
    conversationId,
    channelId,
    modelId: "gpt-5.2",
    title: "session",
    status: "active",
    createdAt: now,
    updatedAt: now,
  });

  await db.insert(agentTasks).values({
    id: taskId,
    userId,
    conversationId,
    channelId,
    modelId: "gpt-5.2",
    title: "task",
    goal: "goal",
    attachments: null,
    complexity: "standard",
    uxMode: "full",
    requiresPlanApproval: true,
    autoStart: false,
    status: "draft",
    createdAt: now,
    updatedAt: now,
  });

  try {
    await deleteChannel(userId, channelId);

    const remainingChannel = await db
      .select()
      .from(channels)
      .where(and(eq(channels.id, channelId), eq(channels.userId, userId)));
    expect(remainingChannel).toHaveLength(0);

    const conversationRows = await db
      .select()
      .from(conversations)
      .where(and(eq(conversations.id, conversationId), eq(conversations.userId, userId)));
    expect(conversationRows).toHaveLength(1);
    expect(conversationRows[0]?.channelId).toBeNull();
    expect(conversationRows[0]?.modelId).toBeNull();

    const sessionRows = await db
      .select()
      .from(agentSessions)
      .where(and(eq(agentSessions.id, sessionId), eq(agentSessions.userId, userId)));
    expect(sessionRows).toHaveLength(1);
    expect(sessionRows[0]?.channelId).toBeNull();
    expect(sessionRows[0]?.modelId).toBeNull();

    const taskRows = await db
      .select()
      .from(agentTasks)
      .where(and(eq(agentTasks.id, taskId), eq(agentTasks.userId, userId)));
    expect(taskRows).toHaveLength(1);
    expect(taskRows[0]?.channelId).toBeNull();
    expect(taskRows[0]?.modelId).toBeNull();
  } finally {
    await db
      .delete(agentTasks)
      .where(and(eq(agentTasks.id, taskId), eq(agentTasks.userId, userId)));
    await db
      .delete(agentSessions)
      .where(and(eq(agentSessions.id, sessionId), eq(agentSessions.userId, userId)));
    await db
      .delete(conversations)
      .where(and(eq(conversations.id, conversationId), eq(conversations.userId, userId)));
    await db.delete(channels).where(and(eq(channels.id, channelId), eq(channels.userId, userId)));
    await db.delete(users).where(eq(users.id, userId));
  }
});
