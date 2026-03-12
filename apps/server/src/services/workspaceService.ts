import { db } from '../db';
import { agentSessions, mcpServers, workspaces } from 'db';
import { eq, and } from 'drizzle-orm';
import { generateId } from '../utils';
import { deleteSettingValue, getSettingValues } from './settingsService';

const DEFAULT_WORKSPACE_SETTING_KEY = 'agent.defaultWorkspaceId';

function normalizeSlug(input: string): string {
  const raw = (input || '').trim().toLowerCase();
  if (!raw) return '';
  // Keep ASCII slugs predictable across devices.
  return raw
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-_]+/g, '-') // replace non-safe chars
    .replace(/-+/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '');
}

async function ensureUniqueWorkspaceSlug(base: string, fallback: string): Promise<string> {
  const root = base || fallback;
  const maxAttempts = 50;
  for (let i = 0; i < maxAttempts; i++) {
    const candidate = i === 0 ? root : `${root}-${i + 1}`;
    const existing = await db.select({ id: workspaces.id }).from(workspaces)
      .where(eq(workspaces.slug, candidate))
      .limit(1);
    if (existing.length === 0) return candidate;
  }
  throw new Error('Slug 已被占用，请换一个。');
}

export interface CreateWorkspaceInput {
  name: string;
  slug?: string;
  description?: string;
  cwd?: string;
}

export interface UpdateWorkspaceInput {
  name?: string;
  description?: string;
  cwd?: string;
}

export async function getWorkspaces(userId: string) {
  const result = await db.select().from(workspaces)
    .where(eq(workspaces.userId, userId));
  return result;
}

export async function getWorkspaceById(userId: string, workspaceId: string) {
  const result = await db.select().from(workspaces)
    .where(and(
      eq(workspaces.id, workspaceId),
      eq(workspaces.userId, userId)
    ))
    .limit(1);
  return result.length > 0 ? result[0] : null;
}

export async function createWorkspace(userId: string, input: CreateWorkspaceInput) {
  const id = generateId();
  const now = new Date();
  const name = (input.name || '').trim();
  if (!name) {
    throw new Error('Name is required');
  }

  const baseSlug = normalizeSlug(input.slug || '') || normalizeSlug(name);
  const fallbackSlug = `workspace-${id.slice(0, 8)}`;
  const slug = await ensureUniqueWorkspaceSlug(baseSlug, fallbackSlug);
  
  await db.insert(workspaces).values({
    id,
    userId,
    name,
    slug,
    description: input.description || null,
    cwd: input.cwd || null,
    createdAt: now,
    updatedAt: now,
  });
  
  return {
    id,
    userId,
    name,
    slug,
    description: input.description,
    cwd: input.cwd,
    createdAt: now,
    updatedAt: now,
  };
}

export async function updateWorkspace(
  userId: string, 
  workspaceId: string, 
  input: UpdateWorkspaceInput
) {
  const existing = await db.select().from(workspaces)
    .where(and(
      eq(workspaces.id, workspaceId),
      eq(workspaces.userId, userId)
    ))
    .limit(1);
  
  if (existing.length === 0) {
    throw new Error('Workspace not found');
  }
  
  const updates: Record<string, unknown> = {
    updatedAt: new Date(),
  };
  
  if (input.name) updates.name = input.name;
  if (input.description !== undefined) updates.description = input.description;
  if (input.cwd !== undefined) updates.cwd = input.cwd;
  
  await db.update(workspaces).set(updates)
    .where(and(
      eq(workspaces.id, workspaceId),
      eq(workspaces.userId, userId)
    ));
  
  return { success: true };
}

export async function deleteWorkspace(userId: string, workspaceId: string) {
  const existing = await getWorkspaceById(userId, workspaceId);
  if (!existing) {
    throw new Error('Workspace not found');
  }

  // Avoid FK constraint failures: remove dependent rows first.
  await db.delete(agentSessions)
    .where(and(eq(agentSessions.userId, userId), eq(agentSessions.workspaceId, workspaceId)));
  // MCP servers are account-level. Keep them, but detach from this workspace.
  await db.update(mcpServers)
    .set({ workspaceId: null, updatedAt: new Date() })
    .where(eq(mcpServers.workspaceId, workspaceId));

  // If the deleted workspace was set as default, clear the setting.
  const values = await getSettingValues(userId, [DEFAULT_WORKSPACE_SETTING_KEY]);
  if (values[DEFAULT_WORKSPACE_SETTING_KEY] === workspaceId) {
    await deleteSettingValue(userId, DEFAULT_WORKSPACE_SETTING_KEY);
  }

  await db.delete(workspaces)
    .where(and(eq(workspaces.id, workspaceId), eq(workspaces.userId, userId)));
  
  return { success: true };
}
