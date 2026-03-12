# Agent MCP Integration Design

## Goal

Pass all enabled MCP server configurations into Claude Agent SDK.

## Scope

- Read enabled MCP servers from DB
- Parse `config` JSON
- Inject into SDK options
- Skip invalid configs and continue

## Out of Scope

- MCP connectivity tests
- Per-workspace MCP
- UI changes

## Data Flow

1. Agent run → resolve workspace + channel
2. Load MCP servers where `is_enabled = true`
3. Parse configs → build `mcpServers`
4. Call SDK with `mcpServers`

## Error Handling

- If a config fails to parse, skip it and log
- If all fail, run with no MCP
