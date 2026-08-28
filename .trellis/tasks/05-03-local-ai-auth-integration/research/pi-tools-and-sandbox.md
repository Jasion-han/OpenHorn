# Pi Mono: Tool System, Sandbox, and Provider Adapters

Source: `github.com/badlogic/pi-mono` (main branch, May 2025)

---

## 1. Tool System Architecture

### Built-in Tools (packages/coding-agent/src/core/tools/)

Pi provides 7 tools, each in its own file:

| Tool | File | Key Parameters |
|------|------|----------------|
| `bash` | `bash.ts` | `command`, `timeout` |
| `read` | `read.ts` | `path`, `offset`, `limit` |
| `write` | `write.ts` | `path`, `content` |
| `edit` | `edit.ts` | `path`, `edits[{oldText, newText}]` |
| `grep` | `grep.ts` | Uses ripgrep (`rg`) binary |
| `find` | `find.ts` | Uses `fd` binary |
| `ls` | `ls.ts` | Directory listing |

Factory functions in `tools/index.ts` create tool sets:
- `createCodingTools(cwd)` -- read, bash, edit, write
- `createReadOnlyTools(cwd)` -- read, grep, find, ls
- `createAllTools(cwd)` -- all 7

### Tool Interface (Two Layers)

**Layer 1 -- `Tool` (packages/ai/src/types.ts):** The LLM-facing schema sent to providers.

```ts
interface Tool<TParameters extends TSchema = TSchema> {
  name: string;
  description: string;
  parameters: TParameters; // TypeBox schema = JSON Schema
}
```

**Layer 2 -- `AgentTool` (packages/agent/src/types.ts):** Extends `Tool` with execution logic.

```ts
interface AgentTool<TParams, TDetails> extends Tool<TParams> {
  label: string;
  execute: (toolCallId, params, signal?, onUpdate?) => Promise<AgentToolResult<TDetails>>;
  executionMode?: "sequential" | "parallel";
  prepareArguments?: (args: unknown) => Static<TParams>;
}
```

**Layer 3 -- `ToolDefinition` (packages/coding-agent/src/core/extensions/types.ts):** Full UI-aware definition with `renderCall()`, `renderResult()`, `promptSnippet`, `promptGuidelines`, and render state. `wrapToolDefinition()` strips UI fields to produce an `AgentTool`.

### Tool Registry Pattern

No formal singleton registry. The `AgentSession` holds tools via its state. Extensions can register tools via `registerTool()`. Dynamic tools are supported: the `dynamic-tools.ts` example extension shows adding/removing tools at runtime.

### Tools Are Provider-Agnostic

Tools are defined once using TypeBox schemas. The same `Tool[]` array is passed to every provider. Each provider adapter has its own `convertTools()` function that serializes the unified schema into provider-specific format.

---

## 2. Provider Adapter Tool Serialization

### Anthropic (`providers/anthropic.ts`)

```ts
function convertTools(tools: Tool[], isOAuthToken, supportsEagerStreaming, cacheControl?) {
  return tools.map((tool, index) => ({
    name: isOAuthToken ? toClaudeCodeName(tool.name) : tool.name,
    description: tool.description,
    ...(supportsEagerStreaming ? { eager_input_streaming: true } : {}),
    input_schema: {
      type: "object",
      properties: schema.properties ?? {},
      required: schema.required ?? [],
    },
    ...(cacheControl && index === tools.length - 1 ? { cache_control: cacheControl } : {}),
  }));
}
```

Key quirks: OAuth tokens remap names to `toClaudeCodeName()`. Cache control breakpoint placed on last tool. Eager input streaming enabled per-model.

### OpenAI Completions (`providers/openai-completions.ts`)

```ts
function convertTools(tools: Tool[], compat) {
  return tools.map(tool => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters as any,
      ...(compat.supportsStrictMode !== false && { strict: false }),
    },
  }));
}
```

Wraps in `{ type: "function", function: { ... } }` envelope. Optional `strict` field gated by compat flags.

### OpenAI Responses (`providers/openai-responses-shared.ts`)

```ts
function convertResponsesTools(tools: Tool[], options?) {
  return tools.map(tool => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters as any,
    strict: options?.strict ?? false,
  }));
}
```

Flatter structure than Completions API (no nested `function` wrapper).

### Google/Gemini (`providers/google-shared.ts`)

```ts
function convertTools(tools: Tool[], useParameters = false) {
  return [{ functionDeclarations: tools.map(tool => ({
    name: tool.name,
    description: tool.description,
    ...(useParameters
      ? { parameters: sanitizeForOpenApi(tool.parameters) }
      : { parametersJsonSchema: tool.parameters }),
  })) }];
}
```

Two modes: `parametersJsonSchema` for full JSON Schema (Gemini native), or `parameters` with OpenAPI sanitization (strips `$schema`, `$defs`, etc.) for Claude-behind-Vertex. Wrapped in `functionDeclarations` array.

### Response Parsing (Unified)

All providers parse tool calls back into the same `ToolCall` type:

```ts
interface ToolCall {
  type: "toolCall";
  id: string;        // Provider-specific ID (tool_use_id for Anthropic, call_xxx for OpenAI)
  name: string;
  arguments: Record<string, any>;
  thoughtSignature?: string; // Google-specific opaque signature
}
```

Each provider handles ID normalization. OpenAI Completions truncates IDs to 40 chars. Google normalizes to 64 chars for Claude-on-Vertex. The agent loop matches tool results back by `id`.

---

## 3. Sandbox / Security

### No Built-in Sandbox in Core

The `packages/coding-agent` core has **no built-in sandboxing**. The bash tool spawns shell processes directly via `child_process.spawn()` with no OS-level isolation.

### Sandbox as Optional Extension

Sandboxing exists as an **extension** (`examples/extensions/sandbox/`), using the `@anthropic-ai/sandbox-runtime` package:

- Uses `sandbox-exec` on macOS, `bubblewrap (bwrap)` on Linux
- Config via `~/.pi/agent/extensions/sandbox.json` (global) and `.pi/sandbox.json` (project-local)
- Defaults: restrict `~/.ssh`, `~/.aws`, `~/.gnupg`; allow writes to cwd and `/tmp`
- Disabled with `--no-sandbox` flag
- Wraps commands via `SandboxManager.wrapWithSandbox()`

### No Workspace Boundary Enforcement

`path-utils.ts` resolves paths but does **not** restrict access. Absolute paths pass through unchanged:
```ts
if (isAbsolute(expanded)) { return expanded; }
```
There is no containment to a project directory.

### Permission Gate (Soft, Extension-Based)

`examples/extensions/permission-gate.ts` demonstrates pre-execution approval:
- Regex patterns detect `rm -rf`, `sudo`, `chmod 777`
- In interactive mode, prompts user for confirmation
- Returns `{ block: true }` to prevent execution
- Uses `beforeToolCall` hook in the agent loop

### No Network Isolation

No network restrictions on tool execution. The bash tool inherits the process environment. The sandbox extension can optionally restrict network access via OS-level profiles, but this is not default.

### Shell Execution Details

`shell.ts` resolves the shell binary (`/bin/bash` preferred, falls back to `sh`). `createLocalBashOperations()` spawns detached processes with `killProcessTree()` for cleanup. Output is truncated to last 200 lines / 512KB. Full output saved to temp file when exceeded.

---

## Key Takeaways for OpenHorn

1. **Tool definitions are provider-agnostic.** TypeBox schemas serve as the single source of truth; each provider adapter has a small `convertTools()` function (10-20 lines) that reshapes to the provider's format.
2. **No formal tool registry.** Tools are arrays passed through session state. Extensions add/remove dynamically.
3. **Sandbox is opt-in, not default.** Core ships without isolation. The extension pattern using `@anthropic-ai/sandbox-runtime` is the reference implementation.
4. **Permission checks use hooks** (`beforeToolCall`/`afterToolCall`), not middleware. Extensions register event listeners on `"tool_call"` events.
5. **Provider quirk handling** is centralized in per-provider `compat` objects (especially `OpenAICompletionsCompat` with 15+ flags) rather than scattered conditionals.
