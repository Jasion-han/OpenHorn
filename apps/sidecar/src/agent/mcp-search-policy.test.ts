import { expect, test } from "bun:test";
import { applyMcpSearchPolicy, isMcpWebSearchTool } from "./mcp-search-policy";

const servers = [
  {
    serverName: "tavily-hikari",
    tools: [
      { name: "mcp__tavily-hikari__tavily_search" },
      { name: "mcp__tavily-hikari__tavily_extract" },
    ],
  },
  {
    serverName: "other",
    tools: [
      { name: "mcp__other__webSearch" },
      { name: "mcp__other__search", description: "Search the web for current information" },
      { name: "mcp__other__search_issues", description: "Search project issues" },
      { name: "mcp__other__query", description: "Search the database" },
    ],
  },
];

test("ordinary Agent searches do not expose competing MCP web searches, preserving other tools/config", () => {
  const original = JSON.stringify(servers);
  const filtered = applyMcpSearchPolicy(servers, { webSearchEnabled: true });
  expect(filtered.flatMap((server) => server.tools.map((tool) => tool.name))).toEqual([
    "mcp__tavily-hikari__tavily_extract",
    "mcp__other__search_issues",
    "mcp__other__query",
  ]);
  expect(JSON.stringify(servers)).toBe(original);
});

test("explicit /server allows only its search tools and a missing target cannot unlock all servers", () => {
  const filtered = applyMcpSearchPolicy(servers, {
    webSearchEnabled: true,
    targetMcpServer: " TAVILY-HIKARI ",
  });
  expect(filtered[0]?.tools).toHaveLength(2);
  expect(filtered[1]?.tools).toHaveLength(2);
  expect(
    applyMcpSearchPolicy(servers, { webSearchEnabled: true, targetMcpServer: "missing" })[0]?.tools,
  ).toHaveLength(1);
});

test("disabled or omitted network consent cannot be bypassed with /server", () => {
  for (const webSearchEnabled of [false, undefined]) {
    const filtered = applyMcpSearchPolicy(servers, {
      webSearchEnabled,
      targetMcpServer: "tavily-hikari",
    });
    expect(filtered[0]?.tools).toHaveLength(1);
  }
});

test("tool identity rather than the MCP server label determines the search capability", () => {
  expect(isMcpWebSearchTool({ name: "mcp__custom__tavily_search" })).toBe(true);
  expect(isMcpWebSearchTool({ name: "mcp__tavily_search__read_file" })).toBe(false);
  expect(isMcpWebSearchTool({ name: "mcp__custom__brave_web_search" })).toBe(true);
  expect(
    isMcpWebSearchTool({
      name: "mcp__code__search",
      description: "A search engine for local code",
    }),
  ).toBe(false);
});
