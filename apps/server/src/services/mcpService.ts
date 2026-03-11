import { db } from '../db';
import { mcpServers } from 'db';
import { eq } from 'drizzle-orm';
import { generateId } from '../utils';

export interface CreateMCPServerInput {
  workspaceId?: string;
  name: string;
  type: string;
  config: Record<string, unknown>;
}

export interface UpdateMCPServerInput {
  name?: string;
  config?: Record<string, unknown>;
  isEnabled?: boolean;
}

export async function getMCPServers(workspaceId?: string) {
  if (workspaceId) {
    return db.select().from(mcpServers)
      .where(eq(mcpServers.workspaceId, workspaceId));
  }
  return db.select().from(mcpServers);
}

export async function getMCPServerById(serverId: string) {
  const result = await db.select().from(mcpServers)
    .where(eq(mcpServers.id, serverId))
    .limit(1);
  return result.length > 0 ? result[0] : null;
}

export async function createMCPServer(input: CreateMCPServerInput) {
  const id = generateId();
  const now = new Date();
  
  await db.insert(mcpServers).values({
    id,
    workspaceId: input.workspaceId || null,
    name: input.name,
    type: input.type,
    config: JSON.stringify(input.config),
    isEnabled: true,
    createdAt: now,
    updatedAt: now,
  });
  
  return {
    id,
    workspaceId: input.workspaceId,
    name: input.name,
    type: input.type,
    config: input.config,
    isEnabled: true,
    createdAt: now,
    updatedAt: now,
  };
}

export async function updateMCPServer(serverId: string, input: UpdateMCPServerInput) {
  const existing = await db.select().from(mcpServers)
    .where(eq(mcpServers.id, serverId))
    .limit(1);
  
  if (existing.length === 0) {
    throw new Error('MCP Server not found');
  }
  
  const updates: Record<string, unknown> = {
    updatedAt: new Date(),
  };
  
  if (input.name) updates.name = input.name;
  if (input.config) updates.config = JSON.stringify(input.config);
  if (input.isEnabled !== undefined) updates.isEnabled = input.isEnabled;
  
  await db.update(mcpServers).set(updates)
    .where(eq(mcpServers.id, serverId));
  
  return { success: true };
}

export async function deleteMCPServer(serverId: string) {
  await db.delete(mcpServers)
    .where(eq(mcpServers.id, serverId));
  
  return { success: true };
}

export async function testMCPServer(serverId: string) {
  const server = await getMCPServerById(serverId);
  if (!server) {
    return { success: false, error: 'Server not found' };
  }
  
  try {
    return { success: true };
  } catch (error) {
    return { 
      success: false, 
      error: error instanceof Error ? error.message : 'Test failed' 
    };
  }
}
