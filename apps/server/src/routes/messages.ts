import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { verifyToken, getUserById } from '../services/authService';
import { getMessages, sendMessage, deleteMessage, streamMessage } from '../services/messageService';

const messages = new Hono();

async function getUser(c: any) {
  const token = getCookie(c, 'token');
  if (!token) return null;
  
  const payload = await verifyToken(token);
  if (!payload) return null;
  
  return getUserById(payload.userId);
}

messages.get('/:conversationId', async (c) => {
  const user = await getUser(c);
  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  
  const conversationId = c.req.param('conversationId');
  const result = await getMessages(conversationId);
  return c.json({ messages: result });
});

messages.post('/', async (c) => {
  const user = await getUser(c);
  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  
  try {
    const body = await c.req.json();
    if (!body?.conversationId) {
      return c.json({ error: 'conversationId is required' }, 400);
    }

    const hasContent = typeof body.content === 'string' && body.content.trim().length > 0;
    const hasAttachments = Array.isArray(body.attachments) && body.attachments.length > 0;
    if (!hasContent && !hasAttachments) {
      return c.json({ error: 'content or attachments are required' }, 400);
    }

    const result = await sendMessage(user.id, body);
    return c.json(result);
  } catch (error) {
    return c.json({ 
      error: error instanceof Error ? error.message : 'Failed to send message' 
    }, 400);
  }
});

messages.post('/stream', async (c) => {
  const user = await getUser(c);
  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  try {
    const body = await c.req.json();
    if (!body?.conversationId) {
      return c.json({ error: 'conversationId is required' }, 400);
    }

    const hasContent = typeof body.content === 'string' && body.content.trim().length > 0;
    const hasAttachments = Array.isArray(body.attachments) && body.attachments.length > 0;
    if (!hasContent && !hasAttachments) {
      return c.json({ error: 'content or attachments are required' }, 400);
    }

    const stream = await streamMessage(user.id, body);

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    });
  } catch (error) {
    return c.json({
      error: error instanceof Error ? error.message : 'Failed to stream message',
    }, 400);
  }
});

messages.delete('/:id', async (c) => {
  const user = await getUser(c);
  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  
  const messageId = c.req.param('id');
  await deleteMessage(user.id, messageId);
  return c.json({ success: true });
});

export default messages;
