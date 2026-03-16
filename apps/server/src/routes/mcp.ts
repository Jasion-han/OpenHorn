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
  
  const servers = await getMCPServers(user.id);
  return c.json({ servers });
});

mcp.get('/servers/:id', async (c) => {
  const user = await getUser(c);
  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  
  const serverId = c.req.param('id');
  const server = await getMCPServerById(user.id, serverId);
  
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
    const server = await createMCPServer(user.id, body);
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
  
  try {
    const serverId = c.req.param('id');
    const body = await c.req.json();
    
    await updateMCPServer(user.id, serverId, body);
    return c.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to update MCP server';
    const status = message === 'MCP Server not found' ? 404 : 400;
    return c.json({ error: message }, status);
  }
});

mcp.delete('/servers/:id', async (c) => {
  const user = await getUser(c);
  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  
  try {
    const serverId = c.req.param('id');
    await deleteMCPServer(user.id, serverId);
    return c.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to delete MCP server';
    const status = message === 'MCP Server not found' ? 404 : 400;
    return c.json({ error: message }, status);
  }
});

mcp.post('/servers/:id/test', async (c) => {
  const user = await getUser(c);
  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  
  const serverId = c.req.param('id');
  const result = await testMCPServer(user.id, serverId);
  
  return c.json(result);
});

export default mcp;
