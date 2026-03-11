import { db } from '../db';
import { workspaces } from 'db';
import { eq, and } from 'drizzle-orm';
import { generateId } from '../utils';

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
  const slug = input.slug || input.name.toLowerCase().replace(/\s+/g, '-');
  
  await db.insert(workspaces).values({
    id,
    userId,
    name: input.name,
    slug,
    description: input.description || null,
    cwd: input.cwd || null,
    createdAt: now,
    updatedAt: now,
  });
  
  return {
    id,
    userId,
    name: input.name,
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
  await db.delete(workspaces)
    .where(and(
      eq(workspaces.id, workspaceId),
      eq(workspaces.userId, userId)
    ));
  
  return { success: true };
}
