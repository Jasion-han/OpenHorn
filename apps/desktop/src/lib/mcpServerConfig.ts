// Normalizes MCP server rows into the config shape shared by both sidecar
// runtimes. The DB stores install-oriented `type` values ("npx", "uvx", ...),
// but the Claude Agent SDK (anthropic protocol) validates `type` against its
// McpServerConfig union and only accepts "stdio" / "sse" / "http" — anything
// else silently drops the server from registration. The direct runtime
// (openai protocol) infers the transport from `url`/`command` instead, so the
// normalized shape stays compatible with it: `type: "stdio"` plus `command`
// still routes to the stdio branch of its buildTransport.

/**
 * Build the per-server config sent to the sidecar. Semantically equivalent to
 * the previous `{ type: serverType, ...config }` spread (a `type` declared in
 * config still wins over the DB column), with the resulting transport type
 * normalized to what the Claude Agent SDK accepts:
 * - declared `sse`/`http` is kept (lowercased);
 * - a bare `url` with no declared transport defaults to `http`, matching the
 *   StreamableHTTP default in the sidecar's buildTransport;
 * - a `command` maps to `stdio`, replacing DB values like `npx`/`uvx`;
 * - configs with neither are returned as-is so downstream code reports them.
 * All other fields (command/args/env/url/headers/alwaysAllow/...) pass through.
 */
export function normalizeMcpServerConfig(
  serverType: string,
  config: Record<string, unknown> | null,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { type: serverType, ...(config || {}) };
  const declared = typeof merged.type === "string" ? merged.type.toLowerCase() : "";
  if (declared === "sse" || declared === "http") return { ...merged, type: declared };
  if (typeof merged.url === "string" && merged.url.length > 0) return { ...merged, type: "http" };
  if (typeof merged.command === "string" && merged.command.length > 0) {
    return { ...merged, type: "stdio" };
  }
  return merged;
}
