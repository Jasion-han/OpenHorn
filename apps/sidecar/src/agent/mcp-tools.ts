import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { TSchema } from "@earendil-works/pi-ai";

/**
 * Bridges enabled MCP servers into the pi-agent-core "direct" runtime so the
 * OpenAI-protocol path (and any non-Claude model) can call MCP tools too — the
 * Claude Agent SDK does this natively; here we do it by hand.
 *
 * Each MCP tool becomes an AgentTool whose `parameters` is the MCP tool's raw
 * JSON Schema. pi-ai validates raw JSON-Schema tool parameters natively (it
 * detects the absence of TypeBox metadata), so no schema conversion is needed.
 */

export type ConnectedMcp = {
  tools: AgentTool<TSchema>[];
  cleanup: () => Promise<void>;
};

const CONNECT_TIMEOUT_MS = 15_000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms),
    ),
  ]);
}

function asStringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function processEnvStrings(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

type AnyTransport = StdioClientTransport | StreamableHTTPClientTransport | SSEClientTransport;

function buildTransport(config: Record<string, unknown>): AnyTransport | null {
  const declared = typeof config.type === "string" ? config.type.toLowerCase() : "";
  const url = typeof config.url === "string" ? config.url : "";

  if (url || declared === "http" || declared === "sse") {
    if (!url) return null;
    const headers = asStringRecord(config.headers);
    const opts = headers ? { requestInit: { headers } } : undefined;
    if (declared === "sse") return new SSEClientTransport(new URL(url), opts);
    return new StreamableHTTPClientTransport(new URL(url), opts);
  }

  const command = typeof config.command === "string" ? config.command : "";
  if (!command) return null;
  const args = Array.isArray(config.args)
    ? config.args.filter((a): a is string => typeof a === "string")
    : undefined;
  // The SDK replaces (does not merge) inherited env when `env` is given, so we
  // merge process.env ourselves to keep PATH etc. available for npx/uvx.
  const env = { ...processEnvStrings(), ...(asStringRecord(config.env) ?? {}) };
  return new StdioClientTransport({ command, ...(args ? { args } : {}), env });
}

function extractText(result: unknown): string {
  const content = (result as { content?: unknown })?.content;
  if (Array.isArray(content)) {
    const parts = content
      .filter((c) => (c as { type?: string })?.type === "text")
      .map((c) => (c as { text?: string }).text ?? "");
    if (parts.length > 0) return parts.join("\n");
    return JSON.stringify(content);
  }
  return typeof result === "string" ? result : JSON.stringify(result ?? {});
}

/**
 * Connects to every provided MCP server (best-effort — a server that fails to
 * connect or list tools is skipped, never fatal) and returns their tools as
 * AgentTools plus a cleanup function that closes all connections.
 */
export async function connectMcpTools(
  mcpServers: Record<string, Record<string, unknown>>,
): Promise<ConnectedMcp> {
  const clients: Client[] = [];
  const tools: AgentTool<TSchema>[] = [];

  for (const [serverName, config] of Object.entries(mcpServers)) {
    try {
      const transport = buildTransport(config);
      if (!transport) continue;
      const client = new Client({ name: "openhorn", version: "1.0.0" });
      await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, `connect ${serverName}`);
      clients.push(client);

      const listed = await withTimeout(
        client.listTools(),
        CONNECT_TIMEOUT_MS,
        `listTools ${serverName}`,
      );
      for (const tool of listed.tools) {
        tools.push({
          name: `mcp__${serverName}__${tool.name}`,
          label: tool.name,
          description: tool.description || `MCP tool "${tool.name}" from ${serverName}.`,
          parameters: (tool.inputSchema ?? { type: "object", properties: {} }) as unknown as TSchema,
          execute: async (_toolCallId, params) => {
            const result = await client.callTool({
              name: tool.name,
              arguments: (params ?? {}) as Record<string, unknown>,
            });
            return { content: [{ type: "text", text: extractText(result) }], details: undefined };
          },
        });
      }
    } catch (error) {
      console.error(
        `[mcp] skipping server "${serverName}":`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  return {
    tools,
    cleanup: async () => {
      await Promise.all(clients.map((c) => c.close().catch(() => {})));
    },
  };
}
