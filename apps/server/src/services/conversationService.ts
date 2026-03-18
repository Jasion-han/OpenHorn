import { conversations, messages } from "db";
import { and, desc, eq } from "drizzle-orm";
import { db } from "../db";
import { generateId } from "../utils";

export interface CreateConversationInput {
  title: string;
  channelId?: string | null;
  modelId?: string | null;
  systemPrompt?: string;
  contextLength?: number;
  defaultMode?: "chat" | "agent" | null;
  forceWebSearch?: boolean;
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

export async function createConversation(userId: string, input: CreateConversationInput) {
  const id = generateId();
  const now = new Date();
  const model = normalizeConversationModelInput(input);
  const defaultMode = input.defaultMode === "chat" ? "chat" : "agent";
  const forceWebSearch = input.forceWebSearch === undefined ? true : Boolean(input.forceWebSearch);

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
  await db.delete(messages).where(eq(messages.conversationId, conversationId));

  await db
    .delete(conversations)
    .where(and(eq(conversations.id, conversationId), eq(conversations.userId, userId)));

  return { success: true };
}
