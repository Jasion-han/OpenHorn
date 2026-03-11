import { db } from '../db';
import { messages, conversations } from 'db';
import { eq, and, asc } from 'drizzle-orm';
import { generateId } from '../utils';
import { createAdapter } from '../agent-adapters';
import { getResolvedChannelForUser } from './channelService';
import { createSseStream } from '../utils/sse';
import { buildAttachmentContextFromIds, linkAttachmentsToMessage } from './attachmentService';

export interface SendMessageInput {
  conversationId: string;
  content: string;
  attachments?: string[];
}

export interface StreamMessageInput {
  conversationId: string;
  content: string;
  attachments?: string[];
}

type ChatMessage = {
  role: 'user' | 'assistant' | 'system';
  content: string;
};

async function buildContentWithAttachments(content: string, attachmentIds?: string[]) {
  if (!attachmentIds || attachmentIds.length === 0) {
    return content;
  }

  const context = await buildAttachmentContextFromIds(attachmentIds);
  if (!context) {
    return content;
  }

  if (!content.trim()) {
    return context;
  }

  return `${content}\n\n${context}`;
}

async function buildChatMessages(
  conversationMessages: Array<{ role: string; content: string; attachments?: string | null }>,
  systemPrompt?: string | null
): Promise<ChatMessage[]> {
  const chatMessages: ChatMessage[] = [];

  if (systemPrompt) {
    chatMessages.push({
      role: 'system',
      content: systemPrompt,
    });
  }

  for (const message of conversationMessages) {
    if (message.role === 'user' && message.attachments) {
      let attachmentIds: string[] = [];
      try {
        attachmentIds = JSON.parse(message.attachments) as string[];
      } catch {
        attachmentIds = [];
      }

      const content = await buildContentWithAttachments(message.content, attachmentIds);
      chatMessages.push({
        role: 'user',
        content,
      });
      continue;
    }

    chatMessages.push({
      role: message.role as ChatMessage['role'],
      content: message.content,
    });
  }

  return chatMessages;
}

async function getConversationForUser(userId: string, conversationId: string) {
  const result = await db.select().from(conversations)
    .where(and(
      eq(conversations.id, conversationId),
      eq(conversations.userId, userId)
    ))
    .limit(1);

  if (result.length === 0) {
    throw new Error('Conversation not found');
  }

  return result[0];
}

export async function getMessages(conversationId: string) {
  const result = await db.select().from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(asc(messages.createdAt));
  
  return result;
}

export async function sendMessage(userId: string, input: SendMessageInput) {
  const conversation = await getConversationForUser(userId, input.conversationId);
  
  const userMessageId = generateId();
  const now = new Date();
  
  await db.insert(messages).values({
    id: userMessageId,
    conversationId: input.conversationId,
    role: 'user',
    content: input.content,
    attachments: input.attachments ? JSON.stringify(input.attachments) : null,
    createdAt: now,
  });

  if (input.attachments?.length) {
    await linkAttachmentsToMessage(input.attachments, userMessageId);
  }
  
  await db.update(conversations)
    .set({ updatedAt: now })
    .where(eq(conversations.id, input.conversationId));
  
  const conversationMessages = await getMessages(input.conversationId);
  const chatMessages = await buildChatMessages(conversationMessages, conversation.systemPrompt);
  
  let responseContent = '';
  let responseModel: string | null = null;
  
  const resolvedChannel = await getResolvedChannelForUser(userId, null);

  if (resolvedChannel) {
    const adapter = createAdapter(
      resolvedChannel.channel.provider,
      resolvedChannel.apiKey,
      resolvedChannel.channel.baseUrl || undefined
    );
    
    const stream = await adapter.chatStream({
      model: resolvedChannel.modelId,
      messages: chatMessages,
      maxTokens: 4096,
    });
    
    for await (const chunk of stream) {
      responseContent += chunk;
    }
    responseModel = resolvedChannel.modelId;
  } else {
    responseContent = 'No channel configured. Please set up a channel first.';
  }
  
  const assistantMessageId = generateId();
  
  await db.insert(messages).values({
    id: assistantMessageId,
    conversationId: input.conversationId,
    role: 'assistant',
    content: responseContent,
    model: responseModel,
    createdAt: new Date(),
  });
  
  return {
    userMessage: {
      id: userMessageId,
      role: 'user',
      content: input.content,
      createdAt: now,
    },
    assistantMessage: {
      id: assistantMessageId,
      role: 'assistant',
      content: responseContent,
      createdAt: new Date(),
    },
  };
}

export async function deleteMessage(userId: string, messageId: string) {
  const message = await db.select().from(messages).where(eq(messages.id, messageId)).limit(1);
  
  if (message.length === 0) {
    throw new Error('Message not found');
  }
  
  const conversation = await db.select().from(conversations)
    .where(and(
      eq(conversations.id, message[0].conversationId),
      eq(conversations.userId, userId)
    ))
    .limit(1);
  
  if (conversation.length === 0) {
    throw new Error('Conversation not found');
  }
  
  await db.delete(messages).where(eq(messages.id, messageId));
  
  return { success: true };
}

export async function streamMessage(userId: string, input: StreamMessageInput): Promise<ReadableStream> {
  return createSseStream(async (send) => {
    const conversation = await getConversationForUser(userId, input.conversationId);

    const userMessageId = generateId();
    const now = new Date();

    await db.insert(messages).values({
      id: userMessageId,
      conversationId: input.conversationId,
      role: 'user',
      content: input.content,
      attachments: input.attachments ? JSON.stringify(input.attachments) : null,
      createdAt: now,
    });

    if (input.attachments?.length) {
      await linkAttachmentsToMessage(input.attachments, userMessageId);
    }

    await db.update(conversations)
      .set({ updatedAt: now })
      .where(eq(conversations.id, input.conversationId));

    const conversationMessages = await getMessages(input.conversationId);
    const chatMessages = await buildChatMessages(conversationMessages, conversation.systemPrompt);

    const resolvedChannel = await getResolvedChannelForUser(userId, null);
    if (!resolvedChannel) {
      send({ type: 'error', message: 'No channel configured' });
      return;
    }

    const adapter = createAdapter(
      resolvedChannel.channel.provider,
      resolvedChannel.apiKey,
      resolvedChannel.channel.baseUrl || undefined
    );

    let responseContent = '';

    const stream = await adapter.chatStream({
      model: resolvedChannel.modelId,
      messages: chatMessages,
      maxTokens: 4096,
    });

    for await (const chunk of stream) {
      responseContent += chunk;
      send({ type: 'delta', content: chunk });
    }

    const assistantMessageId = generateId();
    await db.insert(messages).values({
      id: assistantMessageId,
      conversationId: input.conversationId,
      role: 'assistant',
      content: responseContent,
      model: resolvedChannel.modelId,
      createdAt: new Date(),
    });

    send({
      type: 'done',
      messageId: assistantMessageId,
      model: resolvedChannel.modelId,
    });
  });
}
