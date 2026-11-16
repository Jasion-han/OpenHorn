type Tool = { name: string; description?: string };
type Server<T> = { serverName: string; tools: T[] };

/** Classify general web search, without hiding local/database search or URL-reading tools. */
export function isMcpWebSearchTool(tool: Tool): boolean {
  const name = (tool.name.split("__").at(-1) ?? tool.name)
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .replace(/[-.]/g, "_")
    .toLowerCase();
  if (
    /^(?:web_?search|search_?web|tavily_search|brave_web_search|exa_search|google_search|bing_search|duckduckgo_search)(?:_|$)/.test(
      name,
    )
  )
    return true;
  return (
    /search/.test(name) &&
    /\b(?:search(?:es|ing)?\s+(?:the\s+)?(?:web|internet)|web\s+search)\b/i.test(
      tool.description ?? "",
    )
  );
}

/** Ordinary web search belongs to the selected product source. Explicit /server is opt-in. */
export function applyMcpSearchPolicy<T extends Tool>(
  servers: Server<T>[],
  options: { webSearchEnabled?: boolean; targetMcpServer?: string },
): Server<T>[] {
  const target = options.targetMcpServer?.trim().toLowerCase();
  return servers.map((server) => ({
    ...server,
    tools: server.tools.filter(
      (tool) =>
        !isMcpWebSearchTool(tool) ||
        (options.webSearchEnabled === true && server.serverName.toLowerCase() === target),
    ),
  }));
}
