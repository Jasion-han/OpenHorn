# Claude Agent SDK Analysis for OpenHorn

## 1. Current Status

OpenHorn pins `@anthropic-ai/claude-agent-sdk` at `"latest"` (resolved to **0.2.71**). The SDK wraps the Claude Code CLI as a subprocess (`sdk.query()`) and is **Anthropic-only** -- it spawns a local Claude session with Anthropic credentials. It has no abstraction for non-Anthropic models.

The SDK is actively published (0.2.x cadence) but remains a thin programmatic wrapper around Claude Code. It is not a general-purpose agent framework; it is a convenience layer for embedding Claude Code's tool-use loop in a host process.

## 2. Multi-Model Support

**The Claude Agent SDK does not support non-Anthropic models.** It requires `ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL` and talks exclusively to the Anthropic Messages API (or compatible proxies). There is no provider abstraction, model router, or adapter pattern inside the SDK itself.

## 3. OpenHorn's Current Architecture (Dual Runtime)

OpenHorn already solved this with a **two-runtime** design:

| Runtime | Entry point | Protocol | Models |
|---------|-------------|----------|--------|
| `claude_sdk` | `agentSdk.ts` -> `sdk.query()` | Anthropic SDK subprocess | Claude only |
| `generic_tool_calling` | `genericAgentRuntime.ts` -> custom adapters | Raw HTTP fetch | Any model |

The custom adapters in `agent-adapters.ts` implement:
- **OpenAIAdapter** -- covers OpenAI, DeepSeek, Qwen, Doubao, and any OpenAI-compatible endpoint
- **AnthropicAdapter** -- direct Anthropic Messages API (no subprocess)
- Google -- stubbed (`throw new Error("Unsupported")`)

`channelAgentCheckService.ts` probes the configured channel at runtime and selects `claude_sdk` or `generic_tool_calling` automatically.

## 4. Alternatives Landscape (2026)

| Option | Multi-model | Tool calling | Streaming | Trade-off |
|--------|-------------|-------------|-----------|-----------|
| **Vercel AI SDK** | Yes (OpenAI, Anthropic, Google, Mistral, etc.) | Yes | Yes | Framework-coupled, pulls in Next.js conventions |
| **LiteLLM** | Yes (100+ providers) | Yes | Yes | Python proxy; adds a network hop + new infra |
| **OpenRouter** | Yes (hosted gateway) | Yes | Yes | SaaS dependency; user keys sent to third party |
| **LangChain/LangGraph** | Yes | Yes | Yes | Heavy abstraction; large dependency surface |
| **Custom adapters (current)** | Yes (OpenAI + Anthropic done) | Yes | Yes | Full control; must maintain each adapter |

## 5. Recommendation

**Continue with the current dual-runtime + custom adapter approach.** Rationale:

1. **Already working.** The `OpenAIAdapter` covers the entire OpenAI-compatible ecosystem (GPT, DeepSeek, Qwen, local Ollama, etc.) via `baseUrl`. The `AnthropicAdapter` handles Claude directly. Adding Google Gemini means one more adapter (~200 lines, same pattern).

2. **No new dependencies.** LiteLLM adds a Python sidecar. OpenRouter adds a SaaS middleman. Vercel AI SDK is React/Next-coupled. None of these justify the complexity for three protocols OpenHorn already (mostly) handles.

3. **Claude SDK stays useful** for Anthropic-native channels where the full Claude Code toolset (file editing, search, etc.) is desired. Keep it as the premium path for Anthropic keys.

4. **Minimal next steps:**
   - Implement `GoogleAdapter` (Gemini API uses a different message format but the pattern is identical to the existing adapters).
   - Add local credential detection (scan `~/.config/` for provider key files, environment variables `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`).
   - Keep `createAdapter()` as the single factory; extend `AdapterProtocol` to `"openai" | "anthropic" | "google"`.

Switching frameworks would add dependency risk and migration cost with no functional gain over the current ~1700-line self-contained adapter file.
