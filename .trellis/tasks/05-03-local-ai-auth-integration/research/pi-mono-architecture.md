# Pi Mono Architecture Research

## 1. Overall Architecture

Pi mono (`@mariozechner/pi-*`) is a layered TypeScript monorepo with five packages:

| Package | Role |
|---------|------|
| `pi-ai` | Unified multi-provider LLM API -- model registry, streaming, auth, cost tracking |
| `pi-agent-core` | Stateful agent runtime -- tool execution, event streaming, conversation state |
| `pi-coding-agent` | Interactive coding agent CLI built on the above two |
| `pi-tui` | Terminal UI with differential rendering |
| `pi-web-ui` | Web components for AI chat interfaces |

The dependency chain is: `pi-ai` -> `pi-agent-core` -> `pi-coding-agent`. The AI package is the foundation; the agent package adds state management and tool orchestration; the coding agent is the end-user product.

## 2. AI/Model Adapter Layer (`pi-ai`)

### Provider Registry Pattern

The core abstraction is a **registry-based adapter system** in `api-registry.ts`:

```typescript
interface ApiProvider<TApi extends Api, TOptions extends StreamOptions> {
  api: TApi;
  stream: StreamFunction<TApi, TOptions>;
  streamSimple: StreamFunction<TApi, SimpleStreamOptions>;
}
```

Providers register via `registerApiProvider()`. The `stream()` function in `stream.ts` resolves the provider from the registry and delegates to it. Each provider implements two functions: `stream` (full control with options) and `streamSimple` (simplified interface).

### Provider Implementations

Dedicated adapters exist for: **Anthropic, OpenAI (completions + responses API), Google, Google Vertex, Azure OpenAI, Amazon Bedrock, GitHub Copilot, Mistral, Cloudflare, and OpenAI Codex**. A `faux` provider exists for testing.

Each adapter handles:
- Message format transformation (unified format -> provider-native format)
- Streaming SSE parsing into standardized events
- Tool call serialization/deserialization
- Provider-specific authentication (API key, OAuth, bearer token)

### Unified Event Stream

All providers emit the same event types:

```typescript
type AssistantMessageEvent =
  | { type: "start" }
  | { type: "text_delta"; delta: string }
  | { type: "thinking_delta" }
  | { type: "toolcall_end"; toolCall: ToolCall }
  | { type: "done"; reason: StopReason; message: AssistantMessage }
  | { type: "error" }
```

## 3. Authentication Mechanism

Pi uses a **three-tier credential strategy**:

### Tier 1: Environment Variables (`env-api-keys.ts`)

`getEnvApiKey()` maps each provider to its env var(s):
- `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`, etc.
- **Priority chains**: Anthropic checks `ANTHROPIC_OAUTH_TOKEN` before `ANTHROPIC_API_KEY`
- **GitHub Copilot** checks `COPILOT_GITHUB_TOKEN` -> `GH_TOKEN` -> `GITHUB_TOKEN`
- **Google Vertex**: detects Application Default Credentials at `~/.config/gcloud/application_default_credentials.json`
- **AWS Bedrock**: recognizes profiles, IAM keys, bearer tokens, container/IRSA credentials

### Tier 2: OAuth (`utils/oauth/`)

Three OAuth providers are implemented:
- **Anthropic**: Authorization code flow with PKCE against `claude.ai/oauth/authorize`
- **GitHub Copilot**: Device code flow, then exchanges GitHub token for Copilot-specific token via `/copilot_internal/v2/token`
- **OpenAI Codex**: Separate OAuth flow for Codex access

The `OAuthProviderInterface` requires:
- `login()` -- runs the auth flow, returns `OAuthCredentials`
- `refreshToken(credentials)` -- refreshes expired tokens
- `getApiKey(credentials)` -- extracts the usable API key

Auto-refresh: `getOAuthApiKey()` checks `Date.now() >= creds.expires` and calls `refreshToken()` transparently.

### Tier 3: Explicit Passing

Direct `apiKey` parameter in function calls, required for browser environments.

**Important limitation**: Pi does NOT reuse tokens from other CLI tools (Claude CLI, VS Code, GitHub CLI). Each OAuth flow is self-contained with fresh PKCE challenges.

## 4. Model Capabilities Abstraction

### Model Definition

```typescript
interface Model<TApi> {
  id: string; name: string; api: TApi; provider: Provider;
  reasoning: boolean;
  thinkingLevelMap?: ThinkingLevelMap;
  input: ("text" | "image")[];
  cost: { input, output, cacheRead, cacheWrite }; // $/M tokens
  contextWindow: number; maxTokens: number;
}
```

### Capability Normalization

- **Tool calling**: Required for all models in the registry -- Pi explicitly excludes models without it
- **Reasoning/thinking**: `getSupportedThinkingLevels()` normalizes across providers; `clampThinkingLevel()` maps requested levels to available ones via bidirectional search
- **Vision**: Declared via `input: ["text", "image"]` array
- **Streaming**: All providers must implement streaming; `complete()` wraps it
- **Cross-provider handoffs**: `Context` (system prompt + messages + tools) is serializable and provider-agnostic; `transformMessages()` converts between formats when switching models mid-conversation

### Generated Model Catalog

`models.generated.ts` contains a static catalog of all models with capabilities, costs, and context windows -- likely auto-generated from provider APIs.

## 5. Lessons for OpenHorn

### Multi-Provider Credential Management

- **Adopt the env-var priority chain pattern**: Check OAuth tokens before API keys (e.g., `ANTHROPIC_OAUTH_TOKEN` > `ANTHROPIC_API_KEY`). This lets users of Claude CLI or other OAuth-based tools benefit automatically.
- **Consider adding cross-tool token discovery**: Pi missed this opportunity. OpenHorn could detect tokens from `~/.claude/`, VS Code settings, or `gh auth token` to reduce setup friction. This would be a differentiator.
- **OAuth with auto-refresh is valuable**: The `getOAuthApiKey()` pattern of transparent refresh is clean and worth adopting for providers that support it.

### Unified Model Interface Design

- **Registry pattern is effective**: `registerApiProvider()` + `resolveApiProvider()` decouples the streaming logic from provider details cleanly. OpenHorn's `agent-adapters.ts` could benefit from a formal registry rather than conditional dispatch.
- **Serializable Context is key**: Pi's `Context` type (system prompt + messages + tools) being fully serializable enables cross-provider handoffs and persistence. This is worth adopting for OpenHorn's conversation model.
- **Mandate tool calling**: Pi's decision to only include tool-calling models simplifies the agent layer significantly.

### Tool Calling Abstraction

- **Standardized event types**: The `AssistantMessageEvent` union with `toolcall_start/end` events provides a clean streaming abstraction. OpenHorn's SSE events in `agent.ts` could align with this pattern.
- **TypeBox for tool schemas**: Pi uses TypeBox for type-safe tool definitions with automatic validation -- worth evaluating vs. OpenHorn's current Zod-based approach.
- **Per-provider tool format conversion**: Each adapter owns its own `convertTools()` function, keeping provider quirks isolated (e.g., Anthropic's tool ID sanitization, eager input streaming).
