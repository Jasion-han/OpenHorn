import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { verifyToken, getUserById } from '../services/authService';
import {
  getWorkspaces,
  getWorkspaceById,
  createWorkspace,
  updateWorkspace,
  deleteWorkspace,
} from '../services/workspaceService';

const workspace = new Hono();

async function getUser(c: any) {
  const token = getCookie(c, 'token');
  if (!token) return null;
  
  const payload = await verifyToken(token);
  if (!payload) return null;
  
  return getUserById(payload.userId);
}

workspace.get('/', async (c) => {
  const user = await getUser(c);
  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  
  const workspaces = await getWorkspaces(user.id);
  return c.json({ workspaces });
});

workspace.get('/:id', async (c) => {
  const user = await getUser(c);
  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  
  const workspaceId = c.req.param('id');
  const workspace = await getWorkspaceById(user.id, workspaceId);
  
  if (!workspace) {
    return c.json({ error: 'Workspace not found' }, 404);
  }
  
  return c.json({ workspace });
});

workspace.post('/', async (c) => {
  const user = await getUser(c);
  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  
  try {
    const body = await c.req.json();
    const workspace = await createWorkspace(user.id, body);
    return c.json({ workspace }, 201);
  } catch (error) {
    return c.json({ 
      error: error instanceof Error ? error.message : 'Failed to create workspace' 
    }, 400);
  }
});

workspace.put('/:id', async (c) => {
  const user = await getUser(c);
  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  
  try {
    const workspaceId = c.req.param('id');
    const body = await c.req.json();
    
    await updateWorkspace(user.id, workspaceId, body);
    return c.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to update workspace';
    const status = message === 'Workspace not found' ? 404 : 400;
    return c.json({ error: message }, status);
  }
});

workspace.delete('/:id', async (c) => {
  const user = await getUser(c);
  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  
  try {
    const workspaceId = c.req.param('id');
    await deleteWorkspace(user.id, workspaceId);
    return c.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to delete workspace';
    const status = message === 'Workspace not found' ? 404 : 400;
    return c.json({ error: message }, status);
  }
});

export default workspace;
