# Agent Settings Phase Design

## Goal

Provide Agent settings with global channel usage, global MCP server management, and minimal workspace management (cwd).

## Scope

- Agent settings UI in Settings > Agent
- Workspaces CRUD and selection
- MCP server CRUD (global)
- Agent run uses selected workspace cwd
- Global default channel/model only

## Out of Scope

- Per-workspace MCP
- Per-agent channel selection
- Agent team features

## Server Behavior

- `workspaces` and `mcp_servers` are used as global resources
- Agent run reads `workspaceId` and uses its `cwd`
- Missing workspace errors are explicit

## Client Behavior

- Agent settings page loads workspaces and MCP servers
- Selected workspace stored in agentStore
- If no workspace: show create prompt
