# Adapter Completeness: Claude Agent SDK vs Generic Adapters

## Architecture Overview

Two parallel agent execution paths exist:

1. **Claude Agent SDK path** (`sidecar/src/agent/claude.ts`): Imports `@anthropic-ai/claude-agent-sdk`, delegates tool orchestration, sandboxing, and streaming to the SDK process. OpenHorn adds workspace boundary enforcement, shell risk classification, checkpoint/rollback, and an approval workflow on top.

2. **Generic adapter path** (`server/src/agent-adapters.ts` + `server/src/services/genericAgentRuntime.ts`): Hand-rolled HTTP clients for OpenAI-compatible and Anthropic APIs. The runtime implements a simple tool loop with only a `bash` tool.

## Capability Comparison

| Capability | Claude SDK path | Generic adapter path | Notes |
|---|---|---|---|
| **Tool calling** | 6 tools: Read, Grep, Glob, Write, Edit, Bash (L192) | 1 tool: bash only (L126-143, genericAgentRuntime) | Generic has no file read/write/edit/search tools |
| **Sandbox execution** | Full OS sandbox: macOS sandbox-exec, Linux bwrap; filesystem write-limits, network domain allowlist (L196-221) | None | Commands run unsandboxed in user shell |
| **Approval workflow** | `canUseTool` callback with shell risk classification (`shell-risk.ts`); fs path boundary checks for Read/Write/Edit (L223-259) | `canUseTool` passed through but only for bash; no fs tool path checks (L181-193, genericAgentRuntime) | Generic lacks fs tools so path checks are moot |
| **Checkpoint/rollback** | Pre-tool hook backs up files before Write/Edit; `finalizeCheckpoint` + `rollbackCheckpoint` on completion (`checkpoints.ts`) | Not implemented | No undo capability for generic agents |
| **Streaming events** | SDK emits native async iterable of typed messages; `convertSdkEvent` maps them (L265-268) | Both adapters implement `runToolCallingTurnStream` (OpenAI L780-1062, Anthropic L1438-1669); runtime consumes stream events (L280-307) | Streaming works but event types are simpler (`text_delta`, `tool_call_delta`, `done`) |
| **Workspace boundary** | Write-path symlink traversal check via `resolveWritePathInsideWorkspace`; lexical check for Read; absolute-to-relative normalization (L78-108) | `isSuspiciousNonAsciiCommand` rejects garbled commands (L102-108, genericAgentRuntime); no filesystem boundary enforcement | Generic trusts the model's bash commands |
| **Shell risk assessment** | `classifyBashCommandRisk` with safe-binary allowlist, compound-syntax rejection, unsafe-arg patterns (shell-risk.ts L88-159) | Not used; commands execute directly via `executeBashTool` | No risk classification for generic path |
| **Network isolation** | Sandbox pins outbound to Anthropic API host only (L218-220) | None; bash commands have full network access | |
| **Retry / rate limiting** | Delegated to SDK internals | 2-attempt retry on 429/502/503/504 with linear backoff (L99-101, L438-451); multi-tier stream timeouts: first-token (30s), idle (60s), total (180s) (L83-89) | Generic retry is solid but simple |
| **Error handling** | SDK handles internally; sidecar catches checkpoint failures as best-effort (L173) | Detailed: `readErrorDetail` parses JSON/text error bodies (L211-245); `shouldRetryWithoutForcedToolChoice` auto-downgrades tool_choice on unsupported models (L252-259); timeout errors with Chinese messages | Robust for HTTP-level errors |
| **Max turns** | SDK-managed | 200 turn limit (L17); hard error on exceed (L380) | |
| **Multimodal** | SDK handles natively | Image support in chat (OpenAI base64 data URLs L419-422, Anthropic base64 source L1084-1089); not exposed in tool-calling path | |
| **Tool name fuzzy matching** | SDK handles | `canonicalizeToolName` with normalized key matching (L313-338) | Defensive against model misspelling tool names |

## Gap Analysis

### Critical (blocks basic functionality)

1. **Single tool (bash only)** -- The generic runtime defines only a bash tool (genericAgentRuntime L124-143). The Claude SDK path exposes Read, Grep, Glob, Write, Edit, and Bash. Models using the generic path must accomplish all file operations through shell commands, which is less reliable and produces worse results for structured file editing.

2. **No sandbox execution** -- Generic-path bash commands execute with full user privileges and network access. A compromised or hallucinating model can `rm -rf /`, exfiltrate data via curl, or modify files outside the workspace. The SDK path uses OS-level sandboxing (L196-221).

### Important (degrades experience)

3. **No checkpoint/rollback** -- The SDK path backs up every file before modification and supports full rollback (`checkpoints.ts`). The generic path has no undo mechanism. Users cannot revert agent changes.

4. **No shell risk assessment** -- The SDK path classifies every bash command through `classifyBashCommandRisk` (safe-binary allowlist, compound-syntax detection). The generic path has only `isSuspiciousNonAsciiCommand` (L102-108), which catches garbled Unicode but not `rm -rf` or `curl | sh`.

5. **No workspace boundary enforcement for file operations** -- Since generic only has bash, there is no path validation equivalent to `checkSdkFsToolPath` (claude.ts L78-108). The model can `cat /etc/passwd` or write anywhere.

6. **No network isolation** -- SDK sandboxes pin outbound traffic to the API host. Generic agents can make arbitrary network requests via bash.

### Nice-to-have

7. **Hardcoded max_tokens=1024 in Anthropic adapter** -- Both `runToolCallingTurn` (L1357) and stream variant (L1505) hardcode `max_tokens: 1024`. For complex agent responses this truncates output. The OpenAI adapter omits max_tokens (inherits model default), creating an asymmetry.

8. **No structured file-editing tools** -- Even if security is addressed, the lack of Read/Write/Edit/Grep/Glob tools means the generic agent cannot do precise line-level edits, only full-file rewrites via bash `cat` or `sed`.

9. **Synthetic streaming for non-streaming turns** -- When the adapter does not support streaming, the runtime fakes it by chunking text at 18-char intervals with 14ms delays (L111-122). This works but feels artificial.

10. **No Google adapter** -- `createAdapter` throws for `google` protocol (L1679). Not critical since it falls through to OpenAI-compatible for most providers.

## Summary

The generic adapter system is a competent HTTP client layer with solid streaming, retry, timeout, and error handling for both OpenAI and Anthropic APIs. Its tool-calling implementation correctly handles message format translation, streaming tool call assembly, and tool name canonicalization.

However, as an *agent runtime*, it operates at a fundamentally lower capability level than the Claude SDK path. The two critical gaps -- single-tool limitation and absent sandboxing -- mean the generic path is suitable for simple Q&A-with-bash tasks but not for trusted autonomous coding workflows. Closing those gaps requires adding structured file tools, implementing workspace boundary checks for all tool invocations, and either integrating OS-level sandboxing or building an equivalent permission layer.
