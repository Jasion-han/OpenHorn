import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { mcpServers } from "db";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { isRecord } from "../utils/typeGuards";

export type McpServerConfigMap = Record<string, McpServerConfig>;

type RawMcpServer = {
  id: string;
  name: string;
  type: string;
  config: string;
  isEnabled: boolean;
};

function parseStringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === "string") out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function parseStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.filter((item): item is string => typeof item === "string");
  return items.length > 0 ? items : undefined;
}

function coerceMcpServerConfig(serverType: string, parsed: unknown): McpServerConfig | null {
  if (!isRecord(parsed)) return null;
  const type = serverType.trim().toLowerCase();

  if (type === "http" || type === "sse") {
    const url = parsed.url;
    if (typeof url !== "string" || !url.trim()) return null;
    const headers = parseStringRecord(parsed.headers);
    return { type: type as "http" | "sse", url: url.trim(), ...(headers ? { headers } : {}) };
  }

  // Default to stdio config
  const command = parsed.command;
  if (typeof command !== "string" || !command.trim()) return null;
  const args = parseStringArray(parsed.args);
  const env = parseStringRecord(parsed.env);
  return {
    type: "stdio",
    command: command.trim(),
    ...(args ? { args } : {}),
    ...(env ? { env } : {}),
  };
}

export async function loadEnabledMcpServersForUser(userId: string): Promise<McpServerConfigMap> {
  const rows = await db
    .select()
    .from(mcpServers)
    .where(and(eq(mcpServers.userId, userId), eq(mcpServers.isEnabled, true)));

  return buildMcpServerMap(rows as RawMcpServer[]);
}

export function buildMcpServerMap(servers: RawMcpServer[]): McpServerConfigMap {
  const map: McpServerConfigMap = {};

  for (const server of servers) {
    if (!server.isEnabled) continue;

    try {
      const parsed = JSON.parse(server.config) as unknown;
      const config = coerceMcpServerConfig(server.type, parsed);
      if (!config) continue;
      map[server.name || server.id] = config;
    } catch (_error) {
      console.warn(`[MCP] Invalid config for ${server.name || server.id}`);
    }
  }

  return map;
}
