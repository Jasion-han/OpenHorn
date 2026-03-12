import { db } from '../db';
import { agentSessions, workspaces } from 'db';
import { eq, and } from 'drizzle-orm';
import { generateId } from '../utils';
import { getResolvedChannelForUser } from './channelService';
import { runClaudeAgentSdk } from './agentSdk';
import { loadEnabledMcpServersForUser } from './mcpLoader';
import { buildAttachmentContextFromIds } from './attachmentService';
import { getSettingValues } from './settingsService';

const DEFAULT_WORKSPACE_SETTING_KEY = 'agent.defaultWorkspaceId';

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

  let workspaceId: string | null = input.workspaceId || null;
  if (!workspaceId) {
    const values = await getSettingValues(userId, [DEFAULT_WORKSPACE_SETTING_KEY]);
    const candidate = values[DEFAULT_WORKSPACE_SETTING_KEY];
    if (candidate) {
      const owned = await db.select({ id: workspaces.id }).from(workspaces)
        .where(and(eq(workspaces.id, candidate), eq(workspaces.userId, userId)))
        .limit(1);
      if (owned.length > 0) {
        workspaceId = candidate;
      }
    }
  }
  
  await db.insert(agentSessions).values({
    id,
    userId,
    workspaceId,
    channelId: input.channelId || null,
    title: input.title,
    status: 'active',
    createdAt: now,
    updatedAt: now,
  });
  
  return {
    id,
    userId,
    workspaceId: workspaceId || undefined,
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

export async function renameAgentSession(
  userId: string,
  sessionId: string,
  title: string
) {
  const nextTitle = title.trim();
  if (!nextTitle) {
    throw new Error('title is required');
  }

  const result = await db.update(agentSessions)
    .set({ title: nextTitle, updatedAt: new Date() })
    .where(and(
      eq(agentSessions.id, sessionId),
      eq(agentSessions.userId, userId)
    ));

  const affected = (result as any)?.rowsAffected as number | undefined;
  if (typeof affected === 'number' && affected === 0) {
    throw new Error('Session not found');
  }

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
  attachmentIds: string[] = [],
  abortController?: AbortController
): AsyncGenerator<AgentEvent> {
  const session = await getAgentSessionById(userId, sessionId);
  if (!session) {
    yield { type: 'error', content: 'Session not found' };
    return;
  }

  // If user runs a completed/cancelled session, treat it as reopening.
  if (session.status !== 'active') {
    await db.update(agentSessions)
      .set({ status: 'active', updatedAt: new Date() })
      .where(and(eq(agentSessions.id, sessionId), eq(agentSessions.userId, userId)));
  }
  
  const resolvedChannel = await getResolvedChannelForUser(userId, null);

  if (!resolvedChannel) {
    yield { type: 'error', content: '未配置可用的默认渠道/默认模型。请先在设置中完成配置。' };
    return;
  }

  const values = await getSettingValues(userId, [DEFAULT_WORKSPACE_SETTING_KEY]);
  const defaultWorkspaceId = values[DEFAULT_WORKSPACE_SETTING_KEY] || null;
  const effectiveWorkspaceId = defaultWorkspaceId || session.workspaceId || null;
  if (!effectiveWorkspaceId) {
    yield { type: 'error', content: 'Workspace not selected' };
    return;
  }

  const workspace = await db.select().from(workspaces)
    .where(and(eq(workspaces.id, effectiveWorkspaceId), eq(workspaces.userId, userId)))
    .limit(1);

  if (workspace.length === 0) {
    yield { type: 'error', content: 'Workspace not found' };
    return;
  }

  // Keep the session in sync with global default so UI stays consistent.
  if (effectiveWorkspaceId !== session.workspaceId) {
    await db.update(agentSessions)
      .set({ workspaceId: effectiveWorkspaceId, updatedAt: new Date() })
      .where(and(eq(agentSessions.id, sessionId), eq(agentSessions.userId, userId)));
  }

  const cwd = workspace[0].cwd || undefined;
  
  try {
    const attachmentContext = await buildAttachmentContextFromIds(attachmentIds);
    const finalPrompt = attachmentContext
      ? (prompt.trim() ? `${prompt}\n\n${attachmentContext}` : attachmentContext)
      : prompt;

    const mcpServers = await loadEnabledMcpServersForUser(userId);
    for await (const event of runClaudeAgentSdk({
      apiKey: resolvedChannel.apiKey,
      model: resolvedChannel.modelId,
      prompt: finalPrompt,
      cwd,
      baseUrl: resolvedChannel.channel.baseUrl || undefined,
      mcpServers,
      abortController,
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
