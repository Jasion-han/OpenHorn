/**
 * One-line (or few-line) summary of a tool call's input, shown under the tool
 * name in the agent run panel.
 *
 * Fetch-style tools are identified by the pages they hit, not by the query
 * string that rides along: `tavily_extract` carries both `urls` and `query`, and
 * summarising by query made a two-URL call and a three-URL call render
 * identically — which is exactly the difference a reader is looking for. URLs
 * therefore win over every other field, and each one gets its own line so the
 * panel's 3-line clamp shows them in full rather than truncating one string.
 */
/**
 * The pages a tool call targets, in order. `urls` (array) and `url` (string) are
 * the two shapes in use — MCP fetchers take a batch, built-in ones take one.
 * The run panel renders one row per URL, so this returns a list rather than a
 * joined string: three URLs crammed into one wrapped paragraph is unreadable,
 * and the panel's clamp would cut mid-URL.
 */
export function extractToolUrls(toolInput: unknown): string[] {
  if (!toolInput || typeof toolInput !== "object") return [];
  const input = toolInput as Record<string, unknown>;
  const raw = Array.isArray(input.urls)
    ? input.urls
    : typeof input.url === "string"
      ? [input.url]
      : [];
  return raw
    .filter((item): item is string => typeof item === "string")
    .map((url) => url.trim())
    .filter((url) => url.length > 0);
}

export function summarizeToolInput(toolInput: unknown): string | null {
  if (!toolInput || typeof toolInput !== "object") return null;
  const input = toolInput as Record<string, unknown>;

  const urls = extractToolUrls(toolInput);
  if (urls.length > 0) return urls.join("\n");

  const query =
    typeof input.query === "string"
      ? input.query
      : typeof input.q === "string"
        ? input.q
        : typeof input.search_query === "string"
          ? input.search_query
          : null;
  if (query?.trim()) return query.trim();

  const command =
    typeof input.command === "string"
      ? input.command
      : typeof input.cmd === "string"
        ? input.cmd
        : null;
  if (command?.trim()) return command.trim();

  const path =
    typeof input.path === "string"
      ? input.path
      : typeof input.file_path === "string"
        ? input.file_path
        : null;
  if (path?.trim()) return path.trim();

  try {
    return JSON.stringify(toolInput);
  } catch {
    return null;
  }
}
