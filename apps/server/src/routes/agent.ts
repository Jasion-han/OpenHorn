import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { verifyToken, getUserById } from '../services/authService';
import {
  getAgentSessions,
  getAgentSessionById,
  createAgentSession,
  updateAgentSessionStatus,
  updateAgentSessionChannel,
  renameAgentSession,
  deleteAgentSession,
  runAgent,
  getAgentEvents,
  deleteAgentEvent,
} from '../services/agentService';
import { getResolvedChannelForConversation } from '../services/channelService';
import { checkChannelAgentCompatibility } from '../services/channelAgentCheckService';
import { generateAutoTitle } from '../services/autoTitleService';
import { createSseStream } from '../utils/sse';

const agent = new Hono();

async function getUser(c: any) {
  const token = getCookie(c, 'token');
  if (!token) return null;
  
  const payload = await verifyToken(token);
  if (!payload) return null;
  
  return getUserById(payload.userId);
}

agent.get('/sessions', async (c) => {
  const user = await getUser(c);
  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  
  const sessions = await getAgentSessions(user.id);
  return c.json({ sessions });
});

agent.get('/sessions/:id/events', async (c) => {
  const user = await getUser(c);
  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const sessionId = c.req.param('id');
  const events = await getAgentEvents(user.id, sessionId);
  return c.json({ events });
});

agent.delete('/events/:eventId', async (c) => {
  const user = await getUser(c);
  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  const eventId = c.req.param('eventId');
  const ok = await deleteAgentEvent(user.id, eventId);
  if (!ok) return c.json({ error: 'Not found' }, 404);
  return c.json({ success: true });
});

agent.get('/sessions/:id', async (c) => {
  const user = await getUser(c);
  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  
  const sessionId = c.req.param('id');
  const session = await getAgentSessionById(user.id, sessionId);
  
  if (!session) {
    return c.json({ error: 'Session not found' }, 404);
  }
  
  return c.json({ session });
});

agent.post('/sessions', async (c) => {
  const user = await getUser(c);
  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  
  try {
    const body = await c.req.json();
    const session = await createAgentSession(user.id, body);
    return c.json({ session }, 201);
  } catch (error) {
    return c.json({ 
      error: error instanceof Error ? error.message : 'Failed to create session' 
    }, 400);
  }
});

agent.post('/sessions/:id/run', async (c) => {
  const user = await getUser(c);
  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  
  const sessionId = c.req.param('id');
  const session = await getAgentSessionById(user.id, sessionId);
  if (!session) {
    return c.text('Session not found', 404);
  }

  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
  const { prompt, attachments } = body;

  const hasPrompt = typeof prompt === 'string' && prompt.trim().length > 0;
  const hasAttachments = Array.isArray(attachments) && attachments.length > 0;
  if (!hasPrompt && !hasAttachments) {
    return c.json({ error: 'prompt or attachments are required' }, 400);
  }

  // Agent runtime is Anthropic-only (Claude Agent SDK). Fail fast for other providers
  // so users don't get stuck with a long "Running..." and no output.
  const resolvedChannel = await getResolvedChannelForConversation(user.id, {
    channelId: (session as any).channelId || null,
    modelId: (session as any).modelId || null,
  });
  const provider = resolvedChannel?.channel?.provider;
  if (!provider) {
    return c.text('未配置可用的默认渠道/默认模型。请先在设置中完成配置。', 400);
  }
  if (provider !== 'anthropic') {
    return c.text(
      `Agent 模式目前仅支持 Anthropic(Claude Agent SDK)。当前 Provider: ${provider}。请切换到 Anthropic 渠道后重试。`,
      400
    );
  }

  const compatibility = await checkChannelAgentCompatibility(
    user.id,
    resolvedChannel.channel.id,
    resolvedChannel.modelId
  );
  if (!compatibility.success) {
    return c.text(compatibility.error, 400);
  }
  
  const stream = createSseStream(async (send, ctx) => {
    let sawAny = false;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    const clearIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = null;
    };

    // If the provider doesn't produce any output quickly, fail fast instead of hanging forever.
    const firstOutputTimer = setTimeout(() => {
      try {
        ctx.abortController.abort('first_output_timeout');
      } catch {
        // ignore
      }
    }, 20_000);

    const armIdle = () => {
      clearIdle();
      idleTimer = setTimeout(() => {
        try {
          ctx.abortController.abort('idle_timeout');
        } catch {
          // ignore
        }
      }, 120_000);
    };

    try {
      armIdle();
      for await (const event of runAgent(
      user.id,
      sessionId,
      typeof prompt === 'string' ? prompt : '',
      Array.isArray(attachments) ? attachments : [],
      ctx.abortController
    )) {
        const isVisibleEvent = (event as any)?.type !== 'meta';
        if (isVisibleEvent && !sawAny) {
          sawAny = true;
          clearTimeout(firstOutputTimer);
        }
        // Don't treat meta/keepalive as activity for the idle timer.
        if (isVisibleEvent) {
          armIdle();
        }
        send(event);
      }
    } finally {
      clearTimeout(firstOutputTimer);
      clearIdle();
    }
  });
  
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
});

agent.put('/sessions/:id/channel', async (c) => {
  const user = await getUser(c);
  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const sessionId = c.req.param('id');
  const body = await c.req.json();
  const { channelId, modelId } = body;
  if (!channelId || !modelId) {
    return c.json({ error: 'channelId and modelId are required' }, 400);
  }

  await updateAgentSessionChannel(user.id, sessionId, channelId, modelId);
  return c.json({ success: true });
});

agent.put('/sessions/:id/status', async (c) => {
  const user = await getUser(c);
  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  
  const sessionId = c.req.param('id');
  const body = await c.req.json();
  const { status } = body;
  
  await updateAgentSessionStatus(user.id, sessionId, status);
  return c.json({ success: true });
});

agent.put('/sessions/:id', async (c) => {
  const user = await getUser(c);
  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  try {
    const sessionId = c.req.param('id');
    const body = await c.req.json();
    const title = body?.title;
    if (typeof title !== 'string' || !title.trim()) {
      return c.json({ error: 'title is required' }, 400);
    }

    await renameAgentSession(user.id, sessionId, title);
    return c.json({ success: true });
  } catch (error) {
    if (error instanceof Error && error.message === 'Session not found') {
      return c.json({ error: 'Session not found' }, 404);
    }
    return c.json({
      error: error instanceof Error ? error.message : 'Failed to update session',
    }, 400);
  }
});

agent.delete('/sessions/:id', async (c) => {
  const user = await getUser(c);
  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  
  try {
    const sessionId = c.req.param('id');
    await deleteAgentSession(user.id, sessionId);
    return c.json({ success: true });
  } catch (error) {
    if (error instanceof Error && error.message === 'Session not found') {
      return c.json({ error: 'Session not found' }, 404);
    }
    return c.json({ error: error instanceof Error ? error.message : 'Failed to delete session' }, 400);
  }
});

agent.post('/sessions/:id/auto-title', async (c) => {
  const user = await getUser(c);
  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  try {
    const sessionId = c.req.param('id');
    const session = await getAgentSessionById(user.id, sessionId);
    if (!session) {
      return c.json({ error: 'Session not found' }, 404);
    }
    const body = await c.req.json().catch(() => ({}));
    const prompt = typeof body.prompt === 'string' ? body.prompt : '';
    if (!prompt.trim()) {
      return c.json({ error: 'prompt is required' }, 400);
    }
    const title = await generateAutoTitle(user.id, prompt, (session as any).channelId || null);
    if (!title) {
      return c.json({ success: false, error: 'Failed to generate title' });
    }
    await renameAgentSession(user.id, sessionId, title);
    return c.json({ success: true, title });
  } catch (error) {
    return c.json({ success: false, error: error instanceof Error ? error.message : 'Failed' });
  }
});

export default agent;
