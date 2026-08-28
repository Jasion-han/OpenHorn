# Research: Codex CLI JSON-RPC App-Server Protocol

- **Query**: How does Codex CLI's JSON-RPC app-server protocol work for programmatic integration (subprocess spawning, message format, streaming events)?
- **Scope**: external (GitHub openai/codex repo, npm registry)
- **Date**: 2026-05-04

## Findings

### 1. How to Start Codex CLI Programmatically

Codex CLI exposes `codex app-server` as the programmatic interface. This is the same protocol used by the Codex VS Code extension.

**Command to spawn:**

```bash
codex app-server --listen stdio://
```

**Transport options:**

| Transport | Flag | Format |
|---|---|---|
| stdio (default) | `--listen stdio://` | Newline-delimited JSON (JSONL) on stdin/stdout |
| WebSocket (experimental) | `--listen ws://IP:PORT` | One JSON-RPC message per WS text frame |
| Unix socket | `--listen unix://` or `--listen unix://PATH` | WS over Unix socket |
| Off | `--listen off` | No local transport |

**For OpenHorn integration, stdio is the recommended transport** — spawn the process and communicate over stdin/stdout with JSONL, exactly like the existing Claude SDK subprocess pattern in `agentSdk.ts`.

**Important**: The wire format is JSON-RPC 2.0 **with the `"jsonrpc":"2.0"` header omitted**. Messages are bare JSON objects with `method`, `id`, and `params`/`result`.

**npm package**: `@openai/codex` — latest version `0.128.0`. Install globally: `npm i -g @openai/codex`

### 2. JSON-RPC Message Format

#### Schema Generation

Codex can generate TypeScript types or JSON Schema bundles matching the exact version installed:

```bash
codex app-server generate-ts --out DIR
codex app-server generate-json-schema --out DIR
# Include experimental API surface:
codex app-server generate-ts --out DIR --experimental
```

#### Core Message Types

**Client -> Server:**
- Requests (have `id`): `initialize`, `thread/start`, `thread/resume`, `turn/start`, `turn/interrupt`, `turn/steer`, etc.
- Notifications (no `id`): `initialized`

**Server -> Client:**
- Responses (match `id`): results to client requests
- Notifications (no `id`): `thread/started`, `turn/started`, `turn/completed`, `item/started`, `item/completed`, `item/agentMessage/delta`, etc.
- Server-initiated requests (have `id`, expect client response): approval requests like `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`

### 3. Initialization Handshake (Required)

Every connection must complete initialization before any other method:

```json
// 1. Client sends initialize request
{
  "method": "initialize",
  "id": 0,
  "params": {
    "clientInfo": {
      "name": "openhorn_agent",
      "title": "OpenHorn Agent Runtime",
      "version": "1.0.0"
    },
    "capabilities": {
      "experimentalApi": true
    }
  }
}

// 2. Server responds
{ "id": 0, "result": { "userAgent": "...", "codexHome": "...", "platformFamily": "...", "platformOs": "..." } }

// 3. Client sends initialized notification (no id)
{ "method": "initialized" }
```

### 4. Thread + Turn Lifecycle

#### Core Primitives

| Primitive | Description |
|---|---|
| **Thread** | A conversation between user and Codex agent. Contains multiple turns. |
| **Turn** | One round of conversation (user message -> agent response). Contains multiple items. |
| **Item** | Individual unit within a turn: user message, agent reasoning, agent message, shell command, file edit, etc. |

#### Full Event Lifecycle for a Single Task

```
Client                              Server
  │                                    │
  │── initialize (id:0) ──────────────>│
  │<────────────── result (id:0) ──────│
  │── initialized (notification) ─────>│
  │                                    │
  │── thread/start (id:1) ────────────>│
  │<────────────── result (id:1) ──────│  (returns thread object)
  │<──── thread/started (notification) │
  │                                    │
  │── turn/start (id:2) ──────────────>│
  │<────────────── result (id:2) ──────│  (returns turn object)
  │<───── turn/started (notification) ─│
  │                                    │
  │<──── item/started (notification) ──│  (reasoning item)
  │<── item/reasoning/summaryTextDelta │  (streaming reasoning)
  │<── item/completed (notification) ──│
  │                                    │
  │<──── item/started (notification) ──│  (commandExecution item)
  │<── item/commandExecution/outputDelta│  (streaming command output)
  │<── item/completed (notification) ──│
  │                                    │
  │<──── item/started (notification) ──│  (agentMessage item)
  │<── item/agentMessage/delta ────────│  (streaming text)
  │<── item/agentMessage/delta ────────│  (more streaming text)
  │<── item/completed (notification) ──│
  │                                    │
  │<── turn/completed (notification) ──│  (final status + token usage)
  │                                    │
```

#### Approval Flow (when sandbox requires approval)

When `approvalPolicy` is not `"never"`, the server may send server-initiated requests:

```
  │<── item/started (commandExecution) │
  │<── item/commandExecution/          │
  │    requestApproval (server request)│  (server sends request with id)
  │                                    │
  │── { "id": X, "result":            │
  │     { "decision": "accept" } } ───>│  (client responds)
  │                                    │
  │<── item/commandExecution/          │
  │    outputDelta (notification) ─────│
  │<── item/completed (notification) ──│
```

### 5. Key Methods for OpenHorn Integration

#### thread/start — Create a New Thread

```json
{
  "method": "thread/start",
  "id": 10,
  "params": {
    "model": "gpt-5.1-codex",
    "cwd": "/path/to/project",
    "approvalPolicy": "never",
    "sandbox": "workspaceWrite"
  }
}
```

Response: `{ "id": 10, "result": { "thread": { "id": "thr_123", ... } } }`

#### turn/start — Send User Input

```json
{
  "method": "turn/start",
  "id": 30,
  "params": {
    "threadId": "thr_123",
    "input": [{ "type": "text", "text": "Run tests and fix any failures" }],
    "approvalPolicy": "never",
    "model": "gpt-5.1-codex"
  }
}
```

Response: `{ "id": 30, "result": { "turn": { "id": "turn_456", "status": "inProgress", "items": [] } } }`

#### turn/interrupt — Cancel a Running Turn

```json
{
  "method": "turn/interrupt",
  "id": 31,
  "params": { "threadId": "thr_123", "turnId": "turn_456" }
}
```

#### turn/steer — Add Input to Active Turn

```json
{
  "method": "turn/steer",
  "id": 32,
  "params": {
    "threadId": "thr_123",
    "input": [{ "type": "text", "text": "Focus on failing tests first." }],
    "expectedTurnId": "turn_456"
  }
}
```

### 6. ThreadItem Types (Events You'll Receive)

| Item Type | Description | Delta Events |
|---|---|---|
| `userMessage` | User input content | — |
| `agentMessage` | Accumulated agent reply text | `item/agentMessage/delta` |
| `reasoning` | Model reasoning/thinking | `item/reasoning/summaryTextDelta`, `item/reasoning/textDelta` |
| `commandExecution` | Shell command execution | `item/commandExecution/outputDelta` |
| `fileChange` | File edit proposal/execution | `item/fileChange/patchUpdated` |
| `mcpToolCall` | MCP tool invocation | — |
| `webSearch` | Web search action | — |
| `contextCompaction` | History compaction event | — |
| `plan` | Agent plan output | `item/plan/delta` |

### 7. Authentication

Three modes available:

1. **API Key** — `account/login/start` with `{ "type": "apiKey", "apiKey": "sk-..." }`
2. **ChatGPT Browser Flow** — `account/login/start` with `{ "type": "chatgpt" }`, returns `authUrl` to open
3. **ChatGPT Device Code** — `account/login/start` with `{ "type": "chatgptDeviceCode" }`, returns `verificationUrl` + `userCode`

For OpenHorn server-side integration, API key mode is most practical.

### 8. Error Handling

Errors arrive via:
- `turn/completed` with `status: "failed"` and `error: { message, codexErrorInfo?, additionalDetails? }`
- `error` notification mid-turn

Key error info enums:
- `ContextWindowExceeded`
- `UsageLimitExceeded`
- `HttpConnectionFailed { httpStatusCode? }`
- `ResponseStreamDisconnected { httpStatusCode? }`
- `Unauthorized`
- `BadRequest`

### 9. Comparison with Existing Claude SDK Subprocess Pattern

OpenHorn already has `agentSdk.ts` which spawns Claude CLI as a subprocess via `@anthropic-ai/claude-agent-sdk`. The Codex integration would follow a similar pattern but with key differences:

| Aspect | Claude SDK (current) | Codex App-Server (proposed) |
|---|---|---|
| Spawn method | `sdk.query()` wraps subprocess | `child_process.spawn("codex", ["app-server"])` direct |
| Protocol | Proprietary SDK async iterator | JSON-RPC 2.0 over stdio JSONL |
| Initialization | Automatic (SDK handles) | Manual `initialize` + `initialized` handshake |
| Task submission | `prompt` parameter at creation | `thread/start` then `turn/start` |
| Streaming | `AsyncIterable<SdkMessage>` | JSONL notifications on stdout |
| Approval handling | `canUseTool` callback | Server-initiated JSON-RPC requests requiring response |
| Cancel | `AbortController` | `turn/interrupt` JSON-RPC call |
| Multi-turn | New `query()` call | Same thread, new `turn/start` |

### 10. Sandbox/Permission Policies

For autonomous agent execution (OpenHorn's use case), set:

```json
{
  "approvalPolicy": "never",
  "sandbox": "workspaceWrite"
}
```

Or for full access: `"sandbox": "dangerFullAccess"` (not recommended for untrusted prompts).

The experimental `permissions` profile system offers more granular control:
```json
{
  "permissions": { "type": "profile", "id": ":workspace" }
}
```

### 11. Token Usage Tracking

`thread/tokenUsage/updated` notification streams token usage data during and after turns. Also available in `turn/completed`.

### 12. Goal/Budget API (for Long-Running Tasks)

The `thread/goal/set` API allows setting a persistent objective with token budgets:

```json
{
  "method": "thread/goal/set",
  "id": 27,
  "params": {
    "threadId": "thr_123",
    "objective": "Fix all failing tests",
    "tokenBudget": 200000
  }
}
```

This enables the agent to track progress toward a measurable goal with budget limits.

### 13. Backpressure and Health

- Server uses bounded queues; saturated requests get JSON-RPC error `-32001` ("Server overloaded; retry later")
- Clients should implement exponential backoff with jitter
- When using WebSocket, `GET /readyz` and `GET /healthz` probes are available

## Existing Internal Patterns

### Files Found

| File Path | Description |
|---|---|
| `apps/server/src/services/agentSdk.ts` | Existing Claude SDK subprocess integration — pattern to follow |
| `apps/server/src/services/genericAgentRuntime.ts` | Generic tool-calling agent runtime |
| `apps/server/src/services/genericAgentTypes.ts` | Agent capability mode types (`claude_sdk`, `generic_tool_calling`) |
| `apps/server/src/services/channelAgentCheckService.ts` | Runtime selection logic — needs new `codex_cli` mode |
| `apps/server/src/services/agentService.ts` | Agent service entry point |

### Code Patterns

The existing `AgentCapabilityMode` type at `genericAgentTypes.ts:1` defines:
```typescript
export type AgentCapabilityMode = "claude_sdk" | "generic_tool_calling";
```

A new mode `"codex_cli"` would need to be added here.

The `agentSdk.ts` `runClaudeAgentSdk()` function is an `AsyncGenerator<AgentEvent>` — the Codex runtime should follow this same pattern, yielding `AgentEvent` objects of types: `meta`, `thought`, `text`, `error`, `tool_start`, `tool_result`, `done`.

## External References

- [Codex CLI GitHub Repo](https://github.com/openai/codex) — main repository
- [app-server README](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md) — **primary protocol documentation** (1855 lines, comprehensive)
- [app-server-client crate](https://github.com/openai/codex/tree/main/codex-rs/app-server-client) — Rust in-process client (reference for lifecycle management)
- [app-server-protocol schema](https://github.com/openai/codex/tree/main/codex-rs/app-server-protocol/schema/json) — JSON Schema files for all message types
- [@openai/codex npm](https://www.npmjs.com/package/@openai/codex) — v0.128.0 (latest)
- [Codex Documentation](https://developers.openai.com/codex) — Official docs

## Implementation Blueprint (Minimal Viable Integration)

For OpenHorn to integrate Codex CLI as a subprocess agent runtime, the minimal flow would be:

```typescript
// 1. Spawn process
const proc = spawn("codex", ["app-server", "--listen", "stdio://"]);

// 2. Initialize
send(proc, { method: "initialize", id: 0, params: { clientInfo: { name: "openhorn", ... } } });
// Wait for response
send(proc, { method: "initialized" }); // notification, no id

// 3. Authenticate (API key mode)
send(proc, { method: "account/login/start", id: 1, params: { type: "apiKey", apiKey: "sk-..." } });

// 4. Start thread
send(proc, { method: "thread/start", id: 2, params: { model: "gpt-5.1-codex", cwd: "/project", approvalPolicy: "never" } });
// Read thread.id from response

// 5. Start turn with user prompt
send(proc, { method: "turn/start", id: 3, params: { threadId, input: [{ type: "text", text: userPrompt }] } });

// 6. Stream notifications from stdout
// Parse JSONL, map to AgentEvent:
//   item/agentMessage/delta -> { type: "text", content: delta }
//   item/reasoning/summaryTextDelta -> { type: "thought", content: delta }
//   item/commandExecution/outputDelta -> { type: "tool_result", content: delta }
//   item/started (commandExecution) -> { type: "tool_start", toolName: "shell", ... }
//   turn/completed -> { type: "done" }

// 7. To cancel
send(proc, { method: "turn/interrupt", id: 4, params: { threadId, turnId } });
```

## Caveats / Not Found

1. **No existing npm wrapper package** was found that wraps Codex CLI's app-server protocol for Node.js/Bun. The integration must be built from scratch using raw JSONL over stdio.

2. **No CodexBar or similar open-source project** could be confirmed as using the JSON-RPC protocol programmatically. The VS Code extension is the primary consumer, but it's closed-source integration code.

3. **WebSocket transport is experimental and unsupported** — stdio is the only production-ready transport.

4. **The `"jsonrpc":"2.0"` header is OMITTED on the wire** — this is intentionally different from standard JSON-RPC 2.0, which would normally include it. Parsers must not require it.

5. **Server-initiated requests (approvals)** require the client to respond with a matching `id`. If `approvalPolicy: "never"` is set, these should not occur, but edge cases may exist.

6. **Codex CLI must be installed separately** — it is a Rust binary distributed via npm or Homebrew, not a Node.js library. The server host must have `codex` in PATH.

7. **Authentication state is per-process** — each spawned `codex app-server` process manages its own auth. For API key mode, login must be done after each spawn.

8. **The TypeScript schema can be auto-generated** from the installed Codex version via `codex app-server generate-ts --out DIR`, which guarantees type compatibility with that version.
