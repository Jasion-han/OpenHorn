import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { TSchema } from "@earendil-works/pi-ai";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { sanitizeChildEnv } from "./childEnv";

/**
 * Bridges enabled MCP servers into the pi-agent-core "direct" runtime so the
 * OpenAI-protocol path (and any non-Claude model) can call MCP tools too — the
 * Claude Agent SDK does this natively; here we do it by hand.
 *
 * Each MCP tool becomes an AgentTool whose `parameters` is the MCP tool's raw
 * JSON Schema. pi-ai validates raw JSON-Schema tool parameters natively (it
 * detects the absence of TypeBox metadata), so no schema conversion is needed.
 */

export type McpServerTools = {
  serverName: string;
  tools: AgentTool<TSchema>[];
};

export type ConnectedMcp = {
  tools: AgentTool<TSchema>[];
  /** Per-server grouping in the order the servers were passed in. */
  toolsByServer: McpServerTools[];
  cleanup: () => Promise<void>;
};

const CONNECT_TIMEOUT_MS = 15_000;

// Bound each MCP tool invocation. A slow/hung stdio server must not stall the
// whole agent turn indefinitely; on timeout we surface a tool error so the turn
// can proceed instead of hanging (and the client is still closed on cleanup).
const TOOL_CALL_TIMEOUT_MS = 60_000;

// OpenAI rejects requests carrying more than 128 tool definitions; cap the
// combined built-in + MCP tool count at 120 to keep headroom under that limit.
export const MAX_TOTAL_TOOLS = 120;

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
  // merge process.env ourselves to keep PATH etc. available for npx/uvx — but
  // strip the sidecar's secrets/handshake token first so an arbitrary
  // user-configured stdio server can't read them (config.env still wins).
  const env = { ...sanitizeChildEnv(processEnvStrings()), ...(asStringRecord(config.env) ?? {}) };
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

async function connectServer(
  serverName: string,
  config: Record<string, unknown>,
): Promise<{ client: Client; tools: AgentTool<TSchema>[] } | null> {
  const transport = buildTransport(config);
  if (!transport) return null;
  const client = new Client({ name: "openhorn", version: "1.0.0" });
  // Any failure after this point (connect timeout included — the transport may
  // have already spawned a stdio child) must close the client, or the orphaned
  // process/connection leaks for the sidecar's lifetime.
  try {
    await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, `connect ${serverName}`);
    const listed = await withTimeout(
      client.listTools(),
      CONNECT_TIMEOUT_MS,
      `listTools ${serverName}`,
    );
    const tools: AgentTool<TSchema>[] = listed.tools.map((tool) => ({
      name: `mcp__${serverName}__${tool.name}`,
      label: tool.name,
      description: tool.description || `MCP tool "${tool.name}" from ${serverName}.`,
      parameters: (tool.inputSchema ?? { type: "object", properties: {} }) as unknown as TSchema,
      execute: async (_toolCallId, params) => {
        try {
          const result = await withTimeout(
            client.callTool({
              name: tool.name,
              arguments: (params ?? {}) as Record<string, unknown>,
            }),
            TOOL_CALL_TIMEOUT_MS,
            `callTool ${serverName}/${tool.name}`,
          );
          return { content: [{ type: "text", text: extractText(result) }], details: undefined };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return {
            content: [{ type: "text", text: `MCP tool "${tool.name}" failed: ${message}` }],
            details: undefined,
          };
        }
      },
    }));
    return { client, tools };
  } catch (error) {
    await client.close().catch(() => {});
    throw error;
  }
}

export type McpTestResult = {
  ok: boolean;
  toolCount?: number;
  toolNames?: string[];
  error?: string;
  elapsedMs: number;
};

/**
 * Health-checks a single MCP server with the exact same transport + timeout
 * semantics an agent run uses (buildTransport + 15s connect/listTools via
 * connectServer), so the result reflects real runtime behavior. The
 * connection is closed immediately after listTools — this is a probe, not a
 * session. Failure reasons are passed through verbatim for the UI.
 */
export async function testMcpServer(
  serverName: string,
  config: Record<string, unknown>,
): Promise<McpTestResult> {
  const startedAt = Date.now();
  try {
    const connected = await connectServer(serverName, config);
    if (!connected) {
      return {
        ok: false,
        error: "invalid config: requires a url (http/sse) or a command (stdio)",
        elapsedMs: Date.now() - startedAt,
      };
    }
    const toolNames = connected.tools.map((tool) => tool.label);
    await connected.client.close().catch(() => {});
    return {
      ok: true,
      toolCount: toolNames.length,
      toolNames,
      elapsedMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      elapsedMs: Date.now() - startedAt,
    };
  }
}

/**
 * Connects to every provided MCP server (best-effort — a server that fails to
 * connect or list tools is skipped, never fatal) and returns their tools as
 * AgentTools plus a cleanup function that closes all connections.
 *
 * Servers connect in parallel so one slow/dead server (15s timeout) bounds the
 * total wall time instead of adding to it. Tool order stays deterministic: the
 * results are stitched together in the callers' key order, not completion order.
 */
export async function connectMcpTools(
  mcpServers: Record<string, Record<string, unknown>>,
): Promise<ConnectedMcp> {
  const entries = Object.entries(mcpServers);
  const settled = await Promise.allSettled(
    entries.map(([serverName, config]) => connectServer(serverName, config)),
  );

  const clients: Client[] = [];
  const toolsByServer: McpServerTools[] = [];
  settled.forEach((result, index) => {
    const serverName = entries[index]?.[0] ?? "";
    if (result.status === "rejected") {
      const reason = result.reason;
      console.error(
        `[mcp] skipping server "${serverName}":`,
        reason instanceof Error ? reason.message : reason,
      );
      return;
    }
    if (!result.value) return;
    clients.push(result.value.client);
    toolsByServer.push({ serverName, tools: result.value.tools });
  });

  return {
    tools: toolsByServer.flatMap((s) => s.tools),
    toolsByServer,
    cleanup: async () => {
      await Promise.all(clients.map((c) => c.close().catch(() => {})));
    },
  };
}

/**
 * Enforces the total tool cap at the merge point (where the built-in tool
 * count is known): MCP tools are kept in server order until the combined
 * count would exceed MAX_TOTAL_TOOLS, and anything dropped is reported loudly
 * so a missing tool is never a silent mystery. Callers that must guarantee a
 * specific server survives put it first in the map.
 */
export function capMcpTools(
  builtinToolCount: number,
  toolsByServer: McpServerTools[],
): AgentTool<TSchema>[] {
  const budget = Math.max(0, MAX_TOTAL_TOOLS - builtinToolCount);
  const kept: AgentTool<TSchema>[] = [];
  const dropped: string[] = [];
  for (const { serverName, tools } of toolsByServer) {
    const remaining = budget - kept.length;
    if (remaining >= tools.length) {
      kept.push(...tools);
    } else {
      if (remaining > 0) kept.push(...tools.slice(0, remaining));
      dropped.push(`${serverName} (${tools.length - Math.max(remaining, 0)} tools)`);
    }
  }
  if (dropped.length > 0) {
    const total = builtinToolCount + toolsByServer.reduce((n, s) => n + s.tools.length, 0);
    console.error(
      `[mcp] tool limit exceeded: ${total} tools > cap ${MAX_TOTAL_TOOLS} ` +
        `(${builtinToolCount} built-in). Dropped MCP tools from: ${dropped.join(", ")}. ` +
        `Disable unused MCP servers or call one directly via /<server>.`,
    );
  }
  return kept;
}
