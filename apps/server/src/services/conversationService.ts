import { db } from '../db';
import { conversations, messages } from '../schema';
import { eq, and, desc } from 'drizzle-orm';
import { generateId } from '../utils';

export interface CreateConversationInput {
  title: string;
  channelId?: string;
  systemPrompt?: string;
  contextLength?: number;
}

export interface UpdateConversationInput {
  title?: string;
  systemPrompt?: string;
  contextLength?: number;
  isPinned?: boolean;
}

export async function getConversations(userId: string) {
  const result = await db.select().from(conversations)
    .where(eq(conversations.userId, userId))
    .orderBy(desc(conversations.updatedAt));
  
  return result;
}

export async function getConversationById(userId: string, conversationId: string) {
  const result = await db.select().from(conversations)
    .where(and(
      eq(conversations.id, conversationId),
      eq(conversations.userId, userId)
    ))
    .limit(1);
  
  return result.length > 0 ? result[0] : null;
}

export async function createConversation(userId: string, input: CreateConversationInput) {
  const id = generateId();
  const now = new Date();
  
  await db.insert(conversations).values({
    id,
    userId,
    channelId: null,
    title: input.title,
    systemPrompt: input.systemPrompt || null,
    contextLength: input.contextLength || 4096,
    isPinned: false,
    createdAt: now,
    updatedAt: now,
  });
  
  return {
    id,
    userId,
    channelId: null,
    title: input.title,
    systemPrompt: input.systemPrompt,
    contextLength: input.contextLength || 4096,
    isPinned: false,
    createdAt: now,
    updatedAt: now,
  };
}

export async function updateConversation(
  userId: string, 
  conversationId: string, 
  input: UpdateConversationInput
) {
  const existing = await db.select().from(conversations)
    .where(and(
      eq(conversations.id, conversationId),
      eq(conversations.userId, userId)
    ))
    .limit(1);
  
  if (existing.length === 0) {
    throw new Error('Conversation not found');
  }
  
  const updates: Record<string, unknown> = {
    updatedAt: new Date(),
  };
  
  if (input.title) updates.title = input.title;
  if (input.systemPrompt !== undefined) updates.systemPrompt = input.systemPrompt;
  if (input.contextLength) updates.contextLength = input.contextLength;
  if (input.isPinned !== undefined) updates.isPinned = input.isPinned;
  
  await db.update(conversations).set(updates)
    .where(and(
      eq(conversations.id, conversationId),
      eq(conversations.userId, userId)
    ));
  
  return { success: true };
}

export async function deleteConversation(userId: string, conversationId: string) {
  await db.delete(messages).where(eq(messages.conversationId, conversationId));
  
  await db.delete(conversations)
    .where(and(
      eq(conversations.id, conversationId),
      eq(conversations.userId, userId)
    ));
  
  return { success: true };
}
