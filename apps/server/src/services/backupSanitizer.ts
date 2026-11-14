/** Backup configuration is a portable description, never a credential container. */
const SAFE_COMMANDS = new Set([
  "node",
  "bun",
  "npx",
  "npm",
  "pnpm",
  "uvx",
  "uv",
  "python",
  "python3",
  "docker",
]);
const SAFE_ENDPOINT_PATHS = new Set([
  "/",
  "/v1",
  "/v1/",
  "/v1beta",
  "/v1beta/",
  "/api/v1",
  "/api/v1/",
]);

export function sanitizeBackupEndpoint(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    // Custom path segments, query strings and fragments can all be credentials.
    return url.origin + (SAFE_ENDPOINT_PATHS.has(url.pathname) ? url.pathname : "/");
  } catch {
    return null;
  }
}

export function sanitizeBackupMcp<
  T extends { config: string; type: string; isEnabled: boolean | null },
>(row: T): T {
  let config: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(row.config);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
      config = parsed as Record<string, unknown>;
  } catch {
    /* Invalid configuration must not escape into a backup. */
  }
  const type = ["stdio", "http", "sse", "streamable-http"].includes(row.type) ? row.type : "stdio";
  const safe: Record<string, unknown> = { type };
  // Arbitrary arguments, URLs, environment and headers may hold secrets under
  // any name. Do not guess from key names. Restored servers require setup.
  if (type === "stdio" && typeof config.command === "string" && SAFE_COMMANDS.has(config.command))
    safe.command = config.command;
  return { ...row, config: JSON.stringify(safe), isEnabled: false };
}

export function isSafeBackupSetting(row: { key: string; value: string }): boolean {
  // Every additional setting needs its own bounded value schema. In particular,
  // free-form prompts/templates and unknown keys cannot be assumed secret-free.
  if (row.key === "liveSearch.tavilyEnabled" || row.key === "deepseek.nativeWebEnabled")
    return row.value === "true" || row.value === "false";
  return (
    row.key === "liveSearch.provider" &&
    ["auto", "tavily", "deepseek", "duckduckgo"].includes(row.value)
  );
}
