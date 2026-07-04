import { mcpServers } from "db";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { generateId } from "../utils";

type McpServerRow = typeof mcpServers.$inferSelect;

export interface MCPServerItem {
  id: string;
  userId: string;
  name: string;
  type: string;
  config: Record<string, unknown>;
  isEnabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateMCPServerInput {
  name: string;
  type: string;
  config: Record<string, unknown>;
}

export interface UpdateMCPServerInput {
  name?: string;
  config?: Record<string, unknown>;
  isEnabled?: boolean;
}

function parseConfig(config: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(config) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

function toItem(row: McpServerRow): MCPServerItem {
  return {
    id: row.id,
    userId: row.userId,
    name: row.name,
    type: row.type,
    config: parseConfig(row.config),
    isEnabled: Boolean(row.isEnabled),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function getMCPServers(userId: string): Promise<MCPServerItem[]> {
  const rows = await db.select().from(mcpServers).where(eq(mcpServers.userId, userId));
  return rows.map(toItem);
}

export async function getMCPServerById(
  userId: string,
  serverId: string,
): Promise<MCPServerItem | null> {
  const result = await db
    .select()
    .from(mcpServers)
    .where(and(eq(mcpServers.id, serverId), eq(mcpServers.userId, userId)))
    .limit(1);
  return result.length > 0 ? toItem(result[0]) : null;
}

export async function createMCPServer(
  userId: string,
  input: CreateMCPServerInput,
): Promise<MCPServerItem> {
  const id = generateId();
  const now = new Date();

  await db.insert(mcpServers).values({
    id,
    userId,
    name: input.name,
    type: input.type,
    config: JSON.stringify(input.config),
    isEnabled: true,
    createdAt: now,
    updatedAt: now,
  });

  return {
    id,
    userId,
    name: input.name,
    type: input.type,
    config: input.config,
    isEnabled: true,
    createdAt: now,
    updatedAt: now,
  };
}

export async function updateMCPServer(
  userId: string,
  serverId: string,
  input: UpdateMCPServerInput,
) {
  const existing = await db
    .select()
    .from(mcpServers)
    .where(and(eq(mcpServers.id, serverId), eq(mcpServers.userId, userId)))
    .limit(1);

  if (existing.length === 0) {
    throw new Error("MCP Server not found");
  }

  const updates: Record<string, unknown> = {
    updatedAt: new Date(),
  };

  if (input.name) updates.name = input.name;
  if (input.config) updates.config = JSON.stringify(input.config);
  if (input.isEnabled !== undefined) updates.isEnabled = input.isEnabled;

  await db
    .update(mcpServers)
    .set(updates)
    .where(and(eq(mcpServers.id, serverId), eq(mcpServers.userId, userId)));

  return { success: true };
}

export async function deleteMCPServer(userId: string, serverId: string) {
  const existing = await db
    .select({ id: mcpServers.id })
    .from(mcpServers)
    .where(and(eq(mcpServers.id, serverId), eq(mcpServers.userId, userId)))
    .limit(1);
  if (existing.length === 0) {
    throw new Error("MCP Server not found");
  }

  await db
    .delete(mcpServers)
    .where(and(eq(mcpServers.id, serverId), eq(mcpServers.userId, userId)));

  return { success: true };
}

/**
 * Server-side MCP connection testing is NOT implemented. The server (often a
 * container) cannot faithfully exercise stdio commands that only exist on the
 * user's machine — the real MCP runtime is the desktop sidecar, and the
 * desktop UI tests connections through the sidecar's "mcp.test" RPC instead.
 * An unconditional { success: true } here would be a lie, so this reports
 * honestly until a web-appropriate implementation exists.
 */
export async function testMCPServer(userId: string, serverId: string) {
  const server = await getMCPServerById(userId, serverId);
  if (!server) {
    return { success: false, error: "Server not found" };
  }

  return { success: false, error: "not implemented" };
}
