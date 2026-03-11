import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { verifyToken, getUserById } from '../services/authService';
import {
  getMCPServers,
  getMCPServerById,
  createMCPServer,
  updateMCPServer,
  deleteMCPServer,
  testMCPServer,
} from '../services/mcpService';

const mcp = new Hono();

async function getUser(c: any) {
  const token = getCookie(c, 'token');
  if (!token) return null;
  
  const payload = await verifyToken(token);
  if (!payload) return null;
  
  return getUserById(payload.userId);
}

mcp.get('/servers', async (c) => {
  const user = await getUser(c);
  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  
  const workspaceId = c.req.query('workspaceId');
  const servers = await getMCPServers(workspaceId || undefined);
  return c.json({ servers });
});

mcp.get('/servers/:id', async (c) => {
  const user = await getUser(c);
  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  
  const serverId = c.req.param('id');
  const server = await getMCPServerById(serverId);
  
  if (!server) {
    return c.json({ error: 'Server not found' }, 404);
  }
  
  return c.json({ server });
});

mcp.post('/servers', async (c) => {
  const user = await getUser(c);
  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  
  try {
    const body = await c.req.json();
    const server = await createMCPServer(body);
    return c.json({ server }, 201);
  } catch (error) {
    return c.json({ 
      error: error instanceof Error ? error.message : 'Failed to create server' 
    }, 400);
  }
});

mcp.put('/servers/:id', async (c) => {
  const user = await getUser(c);
  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  
  const serverId = c.req.param('id');
  const body = await c.req.json();
  
  await updateMCPServer(serverId, body);
  return c.json({ success: true });
});

mcp.delete('/servers/:id', async (c) => {
  const user = await getUser(c);
  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  
  const serverId = c.req.param('id');
  await deleteMCPServer(serverId);
  return c.json({ success: true });
});

mcp.post('/servers/:id/test', async (c) => {
  const user = await getUser(c);
  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  
  const serverId = c.req.param('id');
  const result = await testMCPServer(serverId);
  
  return c.json(result);
});

export default mcp;
