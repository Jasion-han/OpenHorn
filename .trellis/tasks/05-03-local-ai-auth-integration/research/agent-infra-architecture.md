# Enterprise Agent Infrastructure Architecture — 2026 Landscape

## 1. Agent Frameworks & Orchestration

| Framework | Architecture | Multi-Model | Tool Ecosystem | Production Readiness | Community | Lock-in Risk |
|-----------|-------------|-------------|----------------|---------------------|-----------|-------------|
| **Claude Agent SDK + MCP** | Single-agent loop with native tool use; MCP for external tools | Anthropic-only (Claude models) | MCP servers (200+ community), file/bash/web built-in | Production (used in Claude Code, Cursor) | Large, fast-growing MCP ecosystem | High (Anthropic-only models) |
| **OpenAI Agents SDK** (ex-Swarm) | Lightweight agent graph; handoffs between agents; built-in tracing | OpenAI-only (GPT-4.5/5 series) | Function calling + code interpreter + file search; Responses API | Production (GA since March 2025) | Very large (OpenAI ecosystem) | High (OpenAI-only) |
| **Google ADK** | Multi-agent orchestration; sequential/parallel/loop agents; A2A protocol native | Google-first but supports LiteLLM wrapper for others | Vertex AI tools, Google Search grounding, MCP adapter | GA (April 2025); maturing fast | Growing; strong enterprise backing | Medium-high (Vertex-native) |
| **LangGraph** | Stateful graph-based orchestration; nodes = functions, edges = routing | Excellent (LangChain model abstraction) | Massive (LangChain integrations, MCP adapters) | Production (LangSmith for observability) | Largest open-source agent community | Low (open-source, model-agnostic) |
| **CrewAI** | Role-based multi-agent; crews with task delegation | Multi-model via LiteLLM | CrewAI tools + LangChain tools | Production; simpler use cases | Medium-large, growing | Low (open-source) |
| **AutoGen / AG2** (Microsoft) | Conversational multi-agent; group chat patterns | Multi-model (Azure OpenAI, others) | Custom tools + code execution | Production (AG2 fork active) | Medium; fragmented after fork | Low-medium |
| **Vercel AI SDK** | Streaming-first; React hooks + server actions; generateText/streamText/generateObject | Excellent (unified provider interface) | Tool calling via provider adapters; MCP support added 2025 | Production (battle-tested in Next.js apps) | Large (Vercel/Next.js ecosystem) | Low (model-agnostic, open-source) |
| **Mastra** | TypeScript-first agent framework; workflow engine + RAG + evals | Multi-model via AI SDK core | Tool system + MCP client support | Early production (v1 2025) | Small but growing | Low (open-source) |

**Key Trend (2025-2026):** The market bifurcated into *vendor SDKs* (Claude Agent SDK, OpenAI Agents SDK, Google ADK) optimized for their own models, and *model-agnostic orchestrators* (LangGraph, Vercel AI SDK, Mastra) that abstract across providers. For enterprise use, the orchestration layer must be model-agnostic while allowing vendor-specific SDKs at the execution layer.

## 2. Protocol & Interoperability Standards

| Protocol | Status (2026) | What It Enables | Adoption |
|----------|--------------|-----------------|----------|
| **MCP (Model Context Protocol)** | De facto standard for tool integration | Standardized tool/resource/prompt exposure; any MCP server works with any MCP client | Anthropic, OpenAI, Google, Cursor, Windsurf, VS Code, JetBrains all support MCP clients. 200+ community servers. |
| **A2A (Agent-to-Agent)** | Google-led; growing adoption | Agent discovery (agent cards), task delegation between agents across organizations, streaming updates | Google Cloud, Salesforce, SAP, LangChain have announced support. Still early for cross-vendor use. |
| **OpenAPI Tool Calling** | Mature but incomplete | HTTP-based tool definitions; every major LLM supports function/tool calling mapped from OpenAPI specs | Universal but lacks agent-specific semantics (no streaming, no multi-turn). |
| **Agent Protocol** (AI Engineer Foundation) | Draft/experimental | Standardized REST API for agent lifecycle (create task, get status, list artifacts) | Limited adoption; superseded by A2A in practice. |

**Assessment:** MCP is the clear winner for tool interoperability — adopt it. A2A matters for multi-agent coordination across services but is not yet critical for a single-org platform. OpenAPI remains the foundation for REST tool integration.

## 3. Infrastructure Patterns

### Pattern Comparison

| Pattern | Description | Pros | Cons | Best For |
|---------|-------------|------|------|----------|
| **Gateway/Proxy** (LiteLLM, OpenRouter) | Centralized proxy that normalizes API calls across providers | Single endpoint, unified auth, cost tracking, rate limiting, fallback routing | No agent logic; just model access. Must pair with orchestration layer. | Model access normalization |
| **SDK/Library** (Vercel AI SDK, LangChain) | Embed agent logic in each application | Maximum flexibility per app; no shared infrastructure dependency | Duplicated logic; inconsistent tool policies; hard to govern centrally | Small teams, few apps |
| **Platform/Service** (custom agent runtime) | Centralized agent execution service with API | Unified governance, shared tool registry, centralized observability | Single point of failure; versioning complexity; higher upfront cost | Enterprise with many AI apps |
| **Hybrid: Gateway + Thin Runtime + App SDK** | Gateway for model access; lightweight runtime for shared tools/policies; thin SDK in apps | Best balance of control and flexibility; apps own UX, platform owns governance | More moving parts; requires clear API contracts | **Recommended for OpenHorn evolution** |

## 4. Key Decision Factors for Enterprise

| Factor | Requirement | Solution Approach |
|--------|------------|-------------------|
| **Multi-model support** | Avoid vendor lock-in across OpenAI, Anthropic, Google, open-source | Model gateway layer (LiteLLM or custom) with unified ProviderAdapter interface |
| **Tool/plugin extensibility** | New tools without platform changes | MCP server standard; tool registry with capability discovery |
| **Security & sandboxing** | Tool execution must be isolated | Sandbox-exec for bash (OpenHorn already does this); container-based execution for untrusted tools; approval workflows |
| **Observability & tracing** | End-to-end visibility into agent runs | OpenTelemetry traces per agent turn; LangSmith or custom event store (OpenHorn's agent_events table) |
| **Cost management** | Per-app/per-user budgets; token accounting | Gateway-level metering; token usage tracking per ProviderAdapter call |
| **Credential management** | Secure multi-provider key storage | Encrypted channel credentials (OpenHorn's existing channelService.ts pattern); vault integration for enterprise |
| **Horizontal scaling** | Handle concurrent agent runs | Stateless agent runtime workers; persistent state in DB; SSE/WebSocket fan-out |

## 5. Recommendation: Architecture for OpenHorn Evolution

### Recommended Three-Layer Architecture

```
┌─────────────────────────────────────────────────────┐
│  Application Layer (apps consuming the platform)     │
│  OpenHorn Desktop / Web / Future Internal Apps       │
│  Thin client: UI + conversation state + SSE stream   │
├─────────────────────────────────────────────────────┤
│  Agent Runtime Layer (the new shared core)           │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────┐ │
│  │ Orchestrator │  │ Tool Registry│  │ MCP Gateway │ │
│  │ (LangGraph   │  │ (MCP servers │  │ (client hub │ │
│  │  or custom)  │  │  + built-in) │  │  for tools) │ │
│  └──────┬──────┘  └──────────────┘  └────────────┘ │
│         │  Shared: auth, approval, sandboxing,       │
│         │  tracing, cost tracking, rate limiting      │
├─────────┴───────────────────────────────────────────┤
│  Model Gateway Layer                                 │
│  Unified ProviderAdapter interface (existing pattern) │
│  OpenAI / Anthropic / Google / Ollama / custom       │
│  Token metering, fallback routing, key management    │
└─────────────────────────────────────────────────────┘
```

### Specific Recommendations

**Build vs Buy vs Open-Source:**
- **Build** the model gateway (OpenHorn's `ProviderAdapter` + `ToolCallingAdapter` already does this well — extend it)
- **Adopt open-source** for orchestration: Vercel AI SDK for the streaming/provider abstraction, or LangGraph if complex multi-agent workflows are needed
- **Adopt MCP** as the standard tool integration protocol (already partially adopted via mcpService.ts)
- **Do not buy** a managed platform; the value is in owning the runtime

**Framework Selection:**
- Keep the existing Bun + Hono server as the runtime host — it is lightweight and fast
- Replace or augment `genericAgentRuntime.ts` with a more formalized agent loop that can be configured per-application
- Use **Vercel AI SDK core** (`ai` package) for its unified provider interface and streaming primitives — it aligns well with the existing TypeScript stack and avoids the weight of LangChain
- Keep **Claude Agent SDK** as a specialized execution mode (the existing `agentSdk.ts` path) for Anthropic-native tasks

**Evolution Path from Current Codebase:**
1. **Extract** `ProviderAdapter` / `ToolCallingAdapter` from `apps/server/src/` into `packages/agent/` as a proper shared package
2. **Formalize** the tool registry: convert the inline tool definitions in `genericAgentRuntime.ts` into MCP-compatible tool descriptors
3. **Add a gateway layer** in front of provider adapters: unified token counting, cost attribution, rate limiting, and fallback routing
4. **Expose the agent runtime as a service API**: other internal apps POST a task spec, receive SSE events — the existing `/agent` route pattern scales to this
5. **Implement A2A agent cards** when multi-service agent coordination becomes a requirement (not urgent today)

**What NOT to Do:**
- Do not adopt a heavy platform like LangChain/LangGraph unless you genuinely need complex multi-agent graph workflows
- Do not use a managed agent hosting service (Vertex AI Agent Builder, AWS Bedrock Agents) — the lock-in is severe and the flexibility is limited
- Do not try to abstract away all provider differences at the prompt level — keep provider-specific optimizations (e.g., Claude extended thinking, GPT-5 reasoning) accessible
