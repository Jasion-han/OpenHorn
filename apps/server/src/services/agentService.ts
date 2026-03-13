import { db } from '../db';
import { agentSessions, workspaces, agentEvents } from 'db';
import { eq, and, desc } from 'drizzle-orm';
import { generateId } from '../utils';
import { getResolvedChannelForUser } from './channelService';
import { runClaudeAgentSdk } from './agentSdk';
import { loadEnabledMcpServersForUser } from './mcpLoader';
import { buildAttachmentContextFromIds } from './attachmentService';
import { getSettingValues } from './settingsService';

async function saveAgentEvent(sessionId: string, event: AgentEvent): Promise<void> {
  if (event.type === 'meta' || event.type === 'done') return;
  try {
    await db.insert(agentEvents).values({
      id: generateId(),
      sessionId,
      type: event.type,
      content: event.content ?? null,
      toolName: event.toolName ?? null,
      toolInput: event.toolInput !== undefined ? JSON.stringify(event.toolInput) : null,
      createdAt: new Date(),
    });
  } catch (e) {
    console.error('[saveAgentEvent] failed:', e);
    // Best-effort; do not break the stream if persistence fails.
  }
}

export async function getAgentEvents(userId: string, sessionId: string): Promise<AgentEvent[]> {
  const session = await getAgentSessionById(userId, sessionId);
  if (!session) return [];
  const rows = await db.select().from(agentEvents)
    .where(eq(agentEvents.sessionId, sessionId))
    .orderBy(agentEvents.createdAt);
  return rows.map((row) => ({
    id: row.id,
    type: row.type as AgentEvent['type'],
    content: row.content ?? undefined,
    toolName: row.toolName ?? undefined,
    toolInput: row.toolInput ? (() => { try { return JSON.parse(row.toolInput!); } catch { return row.toolInput; } })() : undefined,
  }));
}

export async function deleteAgentEvent(userId: string, eventId: string): Promise<boolean> {
  // Verify ownership via session join
  const rows = await db.select({ id: agentEvents.id })
    .from(agentEvents)
    .innerJoin(agentSessions, eq(agentEvents.sessionId, agentSessions.id))
    .where(and(eq(agentEvents.id, eventId), eq(agentSessions.userId, userId)));
  if (rows.length === 0) return false;
  await db.delete(agentEvents).where(eq(agentEvents.id, eventId));
  return true;
}

const DEFAULT_WORKSPACE_SETTING_KEY = 'agent.defaultWorkspaceId';

export interface CreateAgentSessionInput {
  workspaceId?: string;
  channelId?: string;
  title: string;
}

export interface AgentEvent {
  // 'meta' is an internal keepalive/progress signal for SDK/system events. UI may ignore it.
  type: 'meta' | 'text' | 'tool_start' | 'tool_result' | 'done' | 'error';
  content?: string;
  toolName?: string;
  toolInput?: unknown;
}

export async function getAgentSessions(userId: string) {
  const result = await db.select().from(agentSessions)
    .where(eq(agentSessions.userId, userId))
    .orderBy(desc(agentSessions.updatedAt));
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

export async function updateAgentSessionChannel(
  userId: string,
  sessionId: string,
  channelId: string,
  modelId: string
) {
  await db.update(agentSessions)
    .set({ channelId, modelId, updatedAt: new Date() } as any)
    .where(and(eq(agentSessions.id, sessionId), eq(agentSessions.userId, userId)));
  return { success: true };
}

export async function deleteAgentSession(userId: string, sessionId: string) {
  // Delete order matters: agent_events has a FK to agent_sessions without ON DELETE CASCADE
  // in existing databases, so we must delete events first.
  const session = await getAgentSessionById(userId, sessionId);
  if (!session) {
    throw new Error('Session not found');
  }

  await db.delete(agentEvents).where(eq(agentEvents.sessionId, sessionId));
  await db.delete(agentSessions).where(and(eq(agentSessions.id, sessionId), eq(agentSessions.userId, userId)));

  return { success: true };
}

export async function* runAgent(
  userId: string,
  sessionId: string,
  prompt: string,
  attachmentIds: string[] = [],
  abortController?: AbortController
): AsyncGenerator<AgentEvent> {
  const controller = abortController || new AbortController();
  const signal = controller.signal;
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
  
  const resolvedChannel = await getResolvedChannelForUser(userId, (session as any).channelId || null);

  if (!resolvedChannel) {
    yield { type: 'error', content: '未配置可用的默认渠道/默认模型。请先在设置中完成配置。' };
    return;
  }

  // If session has a specific modelId override, use it (falls back to channel default).
  const sessionModelId = (session as any).modelId as string | null | undefined;
  if (sessionModelId) {
    resolvedChannel.modelId = sessionModelId;
  }

  const values = await getSettingValues(userId, [DEFAULT_WORKSPACE_SETTING_KEY, 'chat.systemPrompt']);
  const defaultWorkspaceId = values[DEFAULT_WORKSPACE_SETTING_KEY] || null;
  const globalSystemPrompt = values['chat.systemPrompt'] || undefined;
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

  // Persist the user's prompt as the first event in this turn.
  if (prompt.trim()) {
    await saveAgentEvent(sessionId, { type: 'user' as any, content: prompt.trim() });
  }

  try {
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
        systemPrompt: globalSystemPrompt,
        cwd,
        baseUrl: resolvedChannel.channel.baseUrl || undefined,
        mcpServers,
        abortController: controller,
      })) {
        void saveAgentEvent(sessionId, event);
        yield event;
      }
    } finally {
      // Timers are managed at the route layer (first output / idle). Keep this clean.
    }
  } catch (error) {
    if (signal.aborted) {
      const reason = (signal as any).reason;
      if (reason === 'client_disconnect' || reason === 'user') {
        return;
      }
      if (reason === 'first_output_timeout') {
        yield {
          type: 'error',
          content: '模型长时间无响应（20s）已停止。可能当前渠道不支持 Agent 运行模式，请检查 Provider/Base URL/模型配置。',
        };
        return;
      }
      if (reason === 'idle_timeout') {
        yield {
          type: 'error',
          content: '运行过程中长时间无响应（120s）已停止。请检查渠道配置或减少任务复杂度后重试。',
        };
        return;
      }
    }
    yield {
      type: 'error',
      content: error instanceof Error ? error.message : 'Agent error',
    };
  }
}
