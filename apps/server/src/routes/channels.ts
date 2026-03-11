import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { verifyToken, getUserById } from '../services/authService';
import {
  getChannels,
  getChannelById,
  createChannel,
  updateChannel,
  deleteChannel,
  testChannel,
  fetchChannelModels,
  listChannelModels,
  updateChannelModels,
  setDefaultChannel,
  setDefaultChannelModel,
} from '../services/channelService';

const channels = new Hono();

async function getUser(c: any) {
  const token = getCookie(c, 'token');
  if (!token) return null;
  
  const payload = await verifyToken(token);
  if (!payload) return null;
  
  return getUserById(payload.userId);
}

channels.get('/', async (c) => {
  const user = await getUser(c);
  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  
  const result = await getChannels(user.id);
  return c.json({ channels: result });
});

channels.get('/:id', async (c) => {
  const user = await getUser(c);
  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  
  const channelId = c.req.param('id');
  const channel = await getChannelById(user.id, channelId);
  
  if (!channel) {
    return c.json({ error: 'Channel not found' }, 404);
  }
  
  return c.json({ channel });
});

channels.post('/', async (c) => {
  const user = await getUser(c);
  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  
  try {
    const body = await c.req.json();
    const channel = await createChannel(user.id, body);
    return c.json({ channel }, 201);
  } catch (error) {
    return c.json({ 
      error: error instanceof Error ? error.message : 'Failed to create channel' 
    }, 400);
  }
});

channels.put('/:id', async (c) => {
  const user = await getUser(c);
  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  
  try {
    const channelId = c.req.param('id');
    const body = await c.req.json();
    const channel = await updateChannel(user.id, channelId, body);
    return c.json({ channel });
  } catch (error) {
    return c.json({ 
      error: error instanceof Error ? error.message : 'Failed to update channel' 
    }, 400);
  }
});

channels.delete('/:id', async (c) => {
  const user = await getUser(c);
  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  
  try {
    const channelId = c.req.param('id');
    await deleteChannel(user.id, channelId);
    return c.json({ success: true });
  } catch (error) {
    return c.json({
      error: error instanceof Error ? error.message : 'Failed to delete channel',
    }, 400);
  }
});

channels.post('/:id/test', async (c) => {
  const user = await getUser(c);
  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  
  const channelId = c.req.param('id');
  const result = await testChannel(user.id, channelId);
  
  return c.json(result);
});

channels.post('/:id/fetch-models', async (c) => {
  const user = await getUser(c);
  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const channelId = c.req.param('id');
  const result = await fetchChannelModels(user.id, channelId);
  return c.json(result, result.success ? 200 : 400);
});

channels.get('/:id/models', async (c) => {
  const user = await getUser(c);
  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const channelId = c.req.param('id');
  const models = await listChannelModels(user.id, channelId);
  return c.json({ models });
});

channels.put('/:id/models', async (c) => {
  const user = await getUser(c);
  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  try {
    const channelId = c.req.param('id');
    const body = await c.req.json();
    const models = await updateChannelModels(user.id, channelId, body);
    return c.json({ models });
  } catch (error) {
    return c.json({
      error: error instanceof Error ? error.message : 'Failed to update models',
    }, 400);
  }
});

channels.post('/:id/set-default', async (c) => {
  const user = await getUser(c);
  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  try {
    const channelId = c.req.param('id');
    await setDefaultChannel(user.id, channelId);
    return c.json({ success: true });
  } catch (error) {
    return c.json({
      error: error instanceof Error ? error.message : 'Failed to set default channel',
    }, 400);
  }
});

channels.post('/:id/models/:modelId/set-default', async (c) => {
  const user = await getUser(c);
  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  try {
    const channelId = c.req.param('id');
    const modelId = c.req.param('modelId');
    await setDefaultChannelModel(user.id, channelId, modelId);
    return c.json({ success: true });
  } catch (error) {
    return c.json({
      error: error instanceof Error ? error.message : 'Failed to set default model',
    }, 400);
  }
});

export default channels;
