import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { verifyToken, getUserById } from '../services/authService';
import {
  getConversations,
  getConversationById,
  createConversation,
  updateConversation,
  deleteConversation,
} from '../services/conversationService';

const conversations = new Hono();

async function getUser(c: any) {
  const token = getCookie(c, 'token');
  if (!token) return null;
  
  const payload = await verifyToken(token);
  if (!payload) return null;
  
  return getUserById(payload.userId);
}

conversations.get('/', async (c) => {
  const user = await getUser(c);
  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  
  const result = await getConversations(user.id);
  return c.json({ conversations: result });
});

conversations.get('/:id', async (c) => {
  const user = await getUser(c);
  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  
  const conversationId = c.req.param('id');
  const conversation = await getConversationById(user.id, conversationId);
  
  if (!conversation) {
    return c.json({ error: 'Conversation not found' }, 404);
  }
  
  return c.json({ conversation });
});

conversations.post('/', async (c) => {
  const user = await getUser(c);
  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  
  try {
    const body = await c.req.json();
    const conversation = await createConversation(user.id, body);
    return c.json({ conversation }, 201);
  } catch (error) {
    return c.json({ 
      error: error instanceof Error ? error.message : 'Failed to create conversation' 
    }, 400);
  }
});

conversations.put('/:id', async (c) => {
  const user = await getUser(c);
  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  
  try {
    const conversationId = c.req.param('id');
    const body = await c.req.json();
    await updateConversation(user.id, conversationId, body);
    return c.json({ success: true });
  } catch (error) {
    return c.json({ 
      error: error instanceof Error ? error.message : 'Failed to update conversation' 
    }, 400);
  }
});

conversations.delete('/:id', async (c) => {
  const user = await getUser(c);
  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  
  const conversationId = c.req.param('id');
  await deleteConversation(user.id, conversationId);
  return c.json({ success: true });
});

export default conversations;
