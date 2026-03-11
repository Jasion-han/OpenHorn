import { db } from '../db';
import { agentSessions, workspaces } from 'db';
import { eq, and } from 'drizzle-orm';
import { generateId } from '../utils';
import { getResolvedChannelForUser } from './channelService';
import { runClaudeAgentSdk } from './agentSdk';
import { loadEnabledMcpServers } from './mcpLoader';
import { buildAttachmentContextFromIds } from './attachmentService';

export interface CreateAgentSessionInput {
  workspaceId?: string;
  channelId?: string;
  title: string;
}

export interface AgentEvent {
  type: 'text' | 'tool_start' | 'tool_result' | 'done' | 'error';
  content?: string;
  toolName?: string;
  toolInput?: unknown;
}

export async function getAgentSessions(userId: string) {
  const result = await db.select().from(agentSessions)
    .where(eq(agentSessions.userId, userId))
    .orderBy(agentSessions.updatedAt);
  return result;
}

export async function getAgentSessionById(userId: string, sessionId: string) {
  const result = await db.select().from(agentSessions)
    .where(and(
      eq(agentSessions.id, sessionId),
      eq(agentSessions.userId, userId)
    ))
    .limit(1);
  return result.length > 0 ? result[0] : null;
}

export async function createAgentSession(userId: string, input: CreateAgentSessionInput) {
  const id = generateId();
  const now = new Date();
  
  await db.insert(agentSessions).values({
    id,
    userId,
    workspaceId: input.workspaceId || null,
    channelId: input.channelId || null,
    title: input.title,
    status: 'active',
    createdAt: now,
    updatedAt: now,
  });
  
  return {
    id,
    userId,
    workspaceId: input.workspaceId,
    channelId: input.channelId,
    title: input.title,
    status: 'active',
    createdAt: now,
    updatedAt: now,
  };
}

export async function updateAgentSessionStatus(
  userId: string, 
  sessionId: string, 
  status: 'active' | 'completed' | 'cancelled'
) {
  await db.update(agentSessions)
    .set({ status, updatedAt: new Date() })
    .where(and(
      eq(agentSessions.id, sessionId),
      eq(agentSessions.userId, userId)
    ));
  
  return { success: true };
}

export async function deleteAgentSession(userId: string, sessionId: string) {
  await db.delete(agentSessions)
    .where(and(
      eq(agentSessions.id, sessionId),
      eq(agentSessions.userId, userId)
    ));
  
  return { success: true };
}

export async function* runAgent(
  userId: string,
  sessionId: string,
  prompt: string,
  attachmentIds: string[] = []
): AsyncGenerator<AgentEvent> {
  const session = await getAgentSessionById(userId, sessionId);
  if (!session) {
    yield { type: 'error', content: 'Session not found' };
    return;
  }
  
  const resolvedChannel = await getResolvedChannelForUser(userId, null);

  if (!resolvedChannel) {
    yield { type: 'error', content: 'No channel configured' };
    return;
  }

  let cwd: string | undefined;
  if (session.workspaceId) {
    const workspace = await db.select().from(workspaces)
      .where(and(eq(workspaces.id, session.workspaceId), eq(workspaces.userId, userId)))
      .limit(1);

    if (workspace.length === 0) {
      yield { type: 'error', content: 'Workspace not found' };
      return;
    }

    cwd = workspace[0].cwd || undefined;
  } else {
    yield { type: 'error', content: 'Workspace not selected' };
    return;
  }
  
  try {
    const attachmentContext = await buildAttachmentContextFromIds(attachmentIds);
    const finalPrompt = attachmentContext
      ? (prompt.trim() ? `${prompt}\n\n${attachmentContext}` : attachmentContext)
      : prompt;

    const mcpServers = await loadEnabledMcpServers();
    for await (const event of runClaudeAgentSdk({
      apiKey: resolvedChannel.apiKey,
      model: resolvedChannel.modelId,
      prompt: finalPrompt,
      cwd,
      baseUrl: resolvedChannel.channel.baseUrl || undefined,
      mcpServers,
    })) {
      yield event;
    }
  } catch (error) {
    yield {
      type: 'error',
      content: error instanceof Error ? error.message : 'Agent error',
    };
  }
}
