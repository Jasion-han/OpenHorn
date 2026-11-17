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
  /** Import source id when the entry came from an import; null when created by hand. */
  importedFrom: string | null;
  importedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateMCPServerInput {
  name: string;
  type: string;
  config: Record<string, unknown>;
  /** Set by the desktop MCP importer; stamps `imported_from` / `imported_at`. */
  importedFrom?: string | null;
}

export interface UpdateMCPServerInput {
  name?: string;
  type?: string;
  config?: Record<string, unknown>;
  isEnabled?: boolean;
}

export class McpInputError extends Error {
  readonly errorCode = "invalid_mcp_input";
}
export class McpInvalidConfigError extends Error {
  readonly code = "mcp_invalid_config";

  constructor() {
    super("MCP config must be a JSON object");
    this.name = "McpInvalidConfigError";
  }
}
function objectInput(input: unknown): asserts input is Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new McpInvalidConfigError();
}
function textField(value: unknown, field: string, limit: number): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > limit)
    throw new McpInputError(`Invalid MCP ${field}`);
  return value.trim();
}
function configField(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new McpInvalidConfigError();
  return value as Record<string, unknown>;
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
    importedFrom: row.importedFrom ?? null,
    importedAt: row.importedAt ?? null,
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
  objectInput(input);
  const name = textField(input.name, "name", 160);
  const type = textField(input.type, "type", 40);
  const config = configField(input.config);
  const id = generateId();
  const now = new Date();
  const importedFrom =
    typeof input.importedFrom === "string" && input.importedFrom.trim()
      ? input.importedFrom.trim()
      : null;
  const importedAt = importedFrom ? now : null;

  await db.insert(mcpServers).values({
    id,
    userId,
    name,
    type,
    config: JSON.stringify(config),
    isEnabled: true,
    importedFrom,
    importedAt,
    createdAt: now,
    updatedAt: now,
  });

  return {
    id,
    userId,
    name,
    type,
    config,
    isEnabled: true,
    importedFrom,
    importedAt,
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

  objectInput(input);
  if (input.isEnabled !== undefined && typeof input.isEnabled !== "boolean")
    throw new McpInputError("MCP isEnabled must be boolean");

  const updates: Record<string, unknown> = {
    updatedAt: new Date(),
  };

  if (input.name !== undefined) updates.name = textField(input.name, "name", 160);
  if (input.type !== undefined) updates.type = textField(input.type, "type", 40);
  if (Object.hasOwn(input, "config")) updates.config = JSON.stringify(configField(input.config));
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
