# Agent SDK Integration Design

## Goal

Switch Agent execution to Claude Agent SDK, emitting `text/tool_start/tool_result/done/error` events via SSE.

## Scope

- Replace `runAgent` logic with SDK calls
- Convert SDK events to existing `AgentEvent` shape
- Keep global default channel/model
- Require workspace for `cwd`

## Out of Scope

- MCP execution (reserved for later)
- AskUser / permissions
- Agent Teams

## Data Flow

1. `/agent/sessions/:id/run`
2. Resolve workspace `cwd`
3. Resolve global default channel + model
4. Call Claude Agent SDK with `apiKey + model + cwd + prompt`
5. Stream SDK events → convert → SSE

## Error Handling

- Missing workspace: `error`
- Missing channel: `error`
- SDK error: `error`
