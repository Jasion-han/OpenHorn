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
} from "db";
import { and, desc, eq, inArray, ne, notExists, or, sql } from "drizzle-orm";
import { db } from "../db";
import { generateId } from "../utils";
import { removeAttachmentFiles } from "./attachmentService";
import { ftsDeleteConversation } from "./messageService";
import { deleteChunksByConversation } from "./ragService";

export interface CreateConversationInput {
  title: string;
  channelId?: string | null;
  modelId?: string | null;
  systemPrompt?: string;
  contextLength?: number;
  defaultMode?: "chat" | "agent" | null;
  forceWebSearch?: boolean;
  /**
   * Conversation the caller refuses to have reused. The blank-conversation reuse
   * below only sees persisted messages; a client showing unsaved content (an
   * optimistic send, a run that failed before persisting) passes its id here so
   * that content is never taken over and wiped.
   */
  excludeConversationId?: string;
}

export interface UpdateConversationInput {
  title?: string;
  channelId?: string | null;
  modelId?: string | null;
  systemPrompt?: string;
  contextLength?: number;
  defaultMode?: "chat" | "agent" | null;
  lastMode?: "chat" | "agent" | null;
  isPinned?: boolean;
  forceWebSearch?: boolean;
  runStatus?: string | null;
}

export function normalizeConversationModelInput(input: {
  channelId?: string | null;
  modelId?: string | null;
}): { channelId: string | null; modelId: string | null } {
  const channelId = typeof input.channelId === "string" ? input.channelId : null;
  const modelId = typeof input.modelId === "string" ? input.modelId : null;

  if (channelId && modelId) {
    return { channelId, modelId };
  }

  return { channelId: null, modelId: null };
}

export async function getConversations(userId: string) {
  const result = await db
    .select()
    .from(conversations)
    .where(eq(conversations.userId, userId))
    .orderBy(desc(conversations.updatedAt));

  return result;
}

export async function getConversationById(userId: string, conversationId: string) {
  const result = await db
    .select()
    .from(conversations)
    .where(and(eq(conversations.id, conversationId), eq(conversations.userId, userId)))
    .limit(1);

  return result.length > 0 ? result[0] : null;
}

/**
 * A conversation is reusable when it still carries the caller's untouched
 * default title and holds no messages at all — i.e. it is the blank one the user
 * just made and never used. Renamed-but-empty conversations are excluded: the
 * title is user intent and must not be silently taken over.
 */
async function findReusableBlankConversation(
  userId: string,
  title: string,
  excludeConversationId?: string,
) {
  const rows = await db
    .select()
    .from(conversations)
    .where(
      and(
        eq(conversations.userId, userId),
        eq(conversations.title, title),
        excludeConversationId ? ne(conversations.id, excludeConversationId) : undefined,
        notExists(
          db
            .select({ one: sql`1` })
            .from(messages)
            .where(eq(messages.conversationId, conversations.id)),
        ),
      ),
    )
    .orderBy(desc(conversations.updatedAt))
    .limit(1);

  return rows[0] ?? null;
}

export async function createConversation(userId: string, input: CreateConversationInput) {
  const id = generateId();
  const now = new Date();
  const model = normalizeConversationModelInput(input);
  const defaultMode = input.defaultMode === "chat" ? "chat" : "agent";
  const forceWebSearch = input.forceWebSearch === undefined ? true : Boolean(input.forceWebSearch);

  // 空会话不重复创建。The client keeps an in-memory guard for the conversation it is
  // currently showing, but that guard cannot see blank conversations left behind by
  // an earlier session — after a reload every entry point would mint another one.
  // Enforcing it here covers every caller instead of every call site.
  const reusable = await findReusableBlankConversation(
    userId,
    input.title,
    input.excludeConversationId,
  );
  if (reusable) {
    // Adopt this call's settings: the caller may have picked a different model or
    // mode than the blank conversation was created with.
    const adopted = {
      channelId: model.channelId,
      modelId: model.modelId,
      systemPrompt: input.systemPrompt || null,
      contextLength: input.contextLength || 4096,
      defaultMode,
      lastMode: defaultMode,
      forceWebSearch,
      updatedAt: now,
    };
    await db.update(conversations).set(adopted).where(eq(conversations.id, reusable.id));
    return { ...reusable, ...adopted };
  }

  await db.insert(conversations).values({
    id,
    userId,
    channelId: model.channelId,
    modelId: model.modelId,
    title: input.title,
    systemPrompt: input.systemPrompt || null,
    contextLength: input.contextLength || 4096,
    defaultMode,
    lastMode: defaultMode,
    isPinned: false,
    forceWebSearch,
    runStatus: null,
    createdAt: now,
    updatedAt: now,
  });

  return {
    id,
    userId,
    channelId: model.channelId,
    modelId: model.modelId,
    title: input.title,
    systemPrompt: input.systemPrompt,
    contextLength: input.contextLength || 4096,
    defaultMode,
    lastMode: defaultMode,
    isPinned: false,
    forceWebSearch,
    runStatus: null,
    createdAt: now,
    updatedAt: now,
  };
}

export async function updateConversation(
  userId: string,
  conversationId: string,
  input: UpdateConversationInput,
) {
  const existing = await db
    .select()
    .from(conversations)
    .where(and(eq(conversations.id, conversationId), eq(conversations.userId, userId)))
    .limit(1);

  if (existing.length === 0) {
    throw new Error("Conversation not found");
  }

  const updates: Record<string, unknown> = {
    updatedAt: new Date(),
  };

  if (input.title) updates.title = input.title;
  if (input.channelId !== undefined || input.modelId !== undefined) {
    const model = normalizeConversationModelInput(input);
    updates.channelId = model.channelId;
    updates.modelId = model.modelId;
  }
  if (input.systemPrompt !== undefined) updates.systemPrompt = input.systemPrompt;
  if (input.contextLength !== undefined) updates.contextLength = input.contextLength;
  if (input.defaultMode !== undefined) updates.defaultMode = input.defaultMode;
  if (input.lastMode !== undefined) updates.lastMode = input.lastMode;
  if (input.isPinned !== undefined) updates.isPinned = input.isPinned;
  if (input.forceWebSearch !== undefined) updates.forceWebSearch = input.forceWebSearch;
  if (input.runStatus !== undefined) updates.runStatus = input.runStatus;

  await db
    .update(conversations)
    .set(updates)
    .where(and(eq(conversations.id, conversationId), eq(conversations.userId, userId)));

  return { success: true };
}

export async function deleteConversation(userId: string, conversationId: string) {
  const conversation = await getConversationById(userId, conversationId);
  if (!conversation) {
    return { success: true };
  }

  const [messageRows, sessionRows, taskRows] = await Promise.all([
    db
      .select({ id: messages.id })
      .from(messages)
      .where(eq(messages.conversationId, conversationId)),
    db
      .select({ id: agentSessions.id })
      .from(agentSessions)
      .where(
        and(eq(agentSessions.conversationId, conversationId), eq(agentSessions.userId, userId)),
      ),
    db
      .select({ id: agentTasks.id })
      .from(agentTasks)
      .where(and(eq(agentTasks.conversationId, conversationId), eq(agentTasks.userId, userId))),
  ]);

  const messageIds = messageRows.map((row) => row.id);
  const sessionIds = sessionRows.map((row) => row.id);
  const taskIds = taskRows.map((row) => row.id);

  // Collect the blob paths BEFORE the transaction removes the rows — afterwards
  // there is no way to find the files again. The unlink itself happens after
  // commit, so a rolled-back delete cannot destroy files it did not remove.
  const attachmentConditions = [eq(attachments.conversationId, conversationId)];
  if (messageIds.length > 0) {
    attachmentConditions.push(inArray(attachments.messageId, messageIds));
  }
  if (sessionIds.length > 0) {
    attachmentConditions.push(inArray(attachments.sessionId, sessionIds));
  }
  const attachmentFileRows = await db
    .select({ filePath: attachments.filePath })
    .from(attachments)
    .where(or(...attachmentConditions));
  const attachmentFilePaths = [
    ...new Set(attachmentFileRows.map((row) => row.filePath).filter(Boolean)),
  ];

  await db.transaction(async (tx) => {
    if (messageIds.length > 0) {
      await tx.delete(attachments).where(inArray(attachments.messageId, messageIds));
    }

    if (sessionIds.length > 0) {
      await tx.delete(attachments).where(inArray(attachments.sessionId, sessionIds));
      await tx.delete(agentEvents).where(inArray(agentEvents.sessionId, sessionIds));
      await tx
        .delete(agentSessions)
        .where(and(eq(agentSessions.userId, userId), inArray(agentSessions.id, sessionIds)));
    }

    if (taskIds.length > 0) {
      const runRows = await tx
        .select({ id: agentRuns.id })
        .from(agentRuns)
        .where(inArray(agentRuns.taskId, taskIds));
      const runIds = runRows.map((row) => row.id);

      if (runIds.length > 0) {
        await tx.delete(agentPlanSteps).where(inArray(agentPlanSteps.runId, runIds));
        await tx.delete(agentTaskEvents).where(inArray(agentTaskEvents.runId, runIds));
        await tx.delete(agentApprovalRequests).where(inArray(agentApprovalRequests.runId, runIds));
        await tx.delete(agentArtifacts).where(inArray(agentArtifacts.runId, runIds));
        await tx.delete(agentRuns).where(inArray(agentRuns.id, runIds));
      }

      await tx.delete(agentPlanSteps).where(inArray(agentPlanSteps.taskId, taskIds));
      await tx.delete(agentTaskEvents).where(inArray(agentTaskEvents.taskId, taskIds));
      await tx.delete(agentApprovalRequests).where(inArray(agentApprovalRequests.taskId, taskIds));
      await tx.delete(agentArtifacts).where(inArray(agentArtifacts.taskId, taskIds));
      await tx
        .delete(agentTasks)
        .where(and(eq(agentTasks.userId, userId), inArray(agentTasks.id, taskIds)));
    }

    await tx.delete(attachments).where(eq(attachments.conversationId, conversationId));
    await tx.delete(messages).where(eq(messages.conversationId, conversationId));

    await tx
      .delete(conversations)
      .where(and(eq(conversations.id, conversationId), eq(conversations.userId, userId)));
  });

  await ftsDeleteConversation(conversationId);
  await removeAttachmentFiles(attachmentFilePaths);
  await deleteChunksByConversation(conversationId).catch(() => {});

  return { success: true };
}
