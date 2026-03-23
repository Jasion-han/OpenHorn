import { expect, test } from "bun:test";
import {
  agentApprovalRequests,
  agentArtifacts,
  agentEvents,
  agentPlanSteps,
  agentRuns,
  agentSessions,
  agentTaskEvents,
  agentTasks,
  attachments,
  conversations,
  messages,
  users,
} from "db";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { deleteConversation } from "./conversationService";

test("deleteConversation clears related agent and attachment records before deleting the conversation", async () => {
  const userId = crypto.randomUUID();
  const conversationId = crypto.randomUUID();
  const messageId = crypto.randomUUID();
  const sessionId = crypto.randomUUID();
  const sessionEventId = crypto.randomUUID();
  const taskId = crypto.randomUUID();
  const runId = crypto.randomUUID();
  const planStepId = crypto.randomUUID();
  const taskEventId = crypto.randomUUID();
  const approvalId = crypto.randomUUID();
  const artifactId = crypto.randomUUID();
  const conversationAttachmentId = crypto.randomUUID();
  const messageAttachmentId = crypto.randomUUID();
  const sessionAttachmentId = crypto.randomUUID();
  const now = new Date();

  await db.insert(users).values({
    id: userId,
    email: `${userId}@test.local`,
    username: "u",
    passwordHash: "x",
    createdAt: now,
    updatedAt: now,
  });

  await db.insert(conversations).values({
    id: conversationId,
    userId,
    channelId: null,
    modelId: null,
    title: "verify-standard",
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

  await db.insert(messages).values({
    id: messageId,
    conversationId,
    role: "user",
    content: "hello",
    model: null,
    mode: "agent",
    attachments: null,
    agentRun: null,
    workspaceId: null,
    contextPaths: null,
    liveMetadata: null,
    citations: null,
    createdAt: now,
  });

  await db.insert(agentSessions).values({
    id: sessionId,
    userId,
    conversationId,
    channelId: null,
    modelId: null,
    title: "session",
    status: "active",
    createdAt: now,
    updatedAt: now,
  });

  await db.insert(agentEvents).values({
    id: sessionEventId,
    sessionId,
    type: "text",
    content: "event",
    toolName: null,
    toolInput: null,
    createdAt: now,
  });

  await db.insert(agentTasks).values({
    id: taskId,
    userId,
    conversationId,
    channelId: null,
    modelId: null,
    title: "task",
    goal: "goal",
    attachments: null,
    complexity: "standard",
    uxMode: "full",
    requiresPlanApproval: true,
    autoStart: false,
    status: "awaiting_approval",
    createdAt: now,
    updatedAt: now,
  });

  await db.insert(agentRuns).values({
    id: runId,
    taskId,
    phase: "execution",
    status: "awaiting_approval",
    summary: null,
    error: null,
    startedAt: now,
    completedAt: null,
    createdAt: now,
    updatedAt: now,
  });

  await db.insert(agentPlanSteps).values({
    id: planStepId,
    taskId,
    runId,
    orderIndex: 0,
    title: "step",
    description: null,
    status: "ready",
    createdAt: now,
    updatedAt: now,
  });

  await db.insert(agentTaskEvents).values({
    id: taskEventId,
    taskId,
    runId,
    type: "approval_requested",
    content: "waiting",
    toolName: null,
    toolInput: null,
    metadata: null,
    createdAt: now,
  });

  await db.insert(agentApprovalRequests).values({
    id: approvalId,
    taskId,
    runId,
    type: "plan_approval",
    status: "pending",
    title: "approve",
    description: null,
    payload: null,
    response: null,
    requestedAt: now,
    respondedAt: null,
    createdAt: now,
    updatedAt: now,
  });

  await db.insert(agentArtifacts).values({
    id: artifactId,
    taskId,
    runId,
    type: "execution_summary",
    title: "summary",
    content: "artifact",
    metadata: null,
    createdAt: now,
    updatedAt: now,
  });

  await db.insert(attachments).values([
    {
      id: conversationAttachmentId,
      conversationId,
      sessionId: null,
      messageId: null,
      fileName: "conversation.txt",
      filePath: "/tmp/conversation.txt",
      fileType: "text/plain",
      fileSize: 1,
      createdAt: now,
    },
    {
      id: messageAttachmentId,
      conversationId,
      sessionId: null,
      messageId,
      fileName: "message.txt",
      filePath: "/tmp/message.txt",
      fileType: "text/plain",
      fileSize: 1,
      createdAt: now,
    },
    {
      id: sessionAttachmentId,
      conversationId: null,
      sessionId,
      messageId: null,
      fileName: "session.txt",
      filePath: "/tmp/session.txt",
      fileType: "text/plain",
      fileSize: 1,
      createdAt: now,
    },
  ]);

  try {
    await deleteConversation(userId, conversationId);

    const [
      conversationRows,
      messageRows,
      sessionRows,
      sessionEventRows,
      taskRows,
      runRows,
      planRows,
      taskEventRows,
      approvalRows,
      artifactRows,
      attachmentRows,
    ] = await Promise.all([
      db
        .select()
        .from(conversations)
        .where(and(eq(conversations.id, conversationId), eq(conversations.userId, userId))),
      db.select().from(messages).where(eq(messages.id, messageId)),
      db
        .select()
        .from(agentSessions)
        .where(and(eq(agentSessions.id, sessionId), eq(agentSessions.userId, userId))),
      db.select().from(agentEvents).where(eq(agentEvents.id, sessionEventId)),
      db
        .select()
        .from(agentTasks)
        .where(and(eq(agentTasks.id, taskId), eq(agentTasks.userId, userId))),
      db.select().from(agentRuns).where(eq(agentRuns.id, runId)),
      db.select().from(agentPlanSteps).where(eq(agentPlanSteps.id, planStepId)),
      db.select().from(agentTaskEvents).where(eq(agentTaskEvents.id, taskEventId)),
      db.select().from(agentApprovalRequests).where(eq(agentApprovalRequests.id, approvalId)),
      db.select().from(agentArtifacts).where(eq(agentArtifacts.id, artifactId)),
      db
        .select()
        .from(attachments)
        .where(and(eq(attachments.fileType, "text/plain"), eq(attachments.fileSize, 1))),
    ]);

    expect(conversationRows).toHaveLength(0);
    expect(messageRows).toHaveLength(0);
    expect(sessionRows).toHaveLength(0);
    expect(sessionEventRows).toHaveLength(0);
    expect(taskRows).toHaveLength(0);
    expect(runRows).toHaveLength(0);
    expect(planRows).toHaveLength(0);
    expect(taskEventRows).toHaveLength(0);
    expect(approvalRows).toHaveLength(0);
    expect(artifactRows).toHaveLength(0);
    expect(attachmentRows).toHaveLength(0);
  } finally {
    await db.delete(agentPlanSteps).where(eq(agentPlanSteps.id, planStepId));
    await db.delete(agentTaskEvents).where(eq(agentTaskEvents.id, taskEventId));
    await db.delete(agentApprovalRequests).where(eq(agentApprovalRequests.id, approvalId));
    await db.delete(agentArtifacts).where(eq(agentArtifacts.id, artifactId));
    await db.delete(agentRuns).where(eq(agentRuns.id, runId));
    await db.delete(agentEvents).where(eq(agentEvents.id, sessionEventId));
    await db.delete(attachments).where(eq(attachments.id, conversationAttachmentId));
    await db.delete(attachments).where(eq(attachments.id, messageAttachmentId));
    await db.delete(attachments).where(eq(attachments.id, sessionAttachmentId));
    await db.delete(agentTasks).where(eq(agentTasks.id, taskId));
    await db.delete(agentSessions).where(eq(agentSessions.id, sessionId));
    await db.delete(messages).where(eq(messages.id, messageId));
    await db.delete(conversations).where(eq(conversations.id, conversationId));
    await db.delete(users).where(eq(users.id, userId));
  }
});
