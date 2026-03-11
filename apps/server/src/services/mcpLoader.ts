import { db } from '../db';
import { mcpServers } from '../schema';
import { eq } from 'drizzle-orm';

export type McpServerConfigMap = Record<string, Record<string, unknown>>;

type RawMcpServer = {
  id: string;
  name: string;
  type: string;
  config: string;
  isEnabled: boolean;
};

export async function loadEnabledMcpServers(): Promise<McpServerConfigMap> {
  const rows = await db.select().from(mcpServers)
    .where(eq(mcpServers.isEnabled, true));

  return buildMcpServerMap(rows as RawMcpServer[]);
}

export function buildMcpServerMap(servers: RawMcpServer[]): McpServerConfigMap {
  const map: McpServerConfigMap = {};

  for (const server of servers) {
    if (!server.isEnabled) continue;

    try {
      const parsed = JSON.parse(server.config) as Record<string, unknown>;
      map[server.name || server.id] = {
        type: server.type,
        ...parsed,
      };
    } catch (error) {
      console.warn(`[MCP] Invalid config for ${server.name || server.id}`);
    }
  }

  return map;
}
