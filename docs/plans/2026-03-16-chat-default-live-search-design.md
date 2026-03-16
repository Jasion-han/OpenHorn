# Chat Default Live Search Design

**Context**

OpenHorn currently splits capabilities incorrectly:

- `chat` is mostly a direct model call with no built-in live search path.
- `agent` can use MCP, but only after the user configures tools manually.
- This makes normal chat feel weaker than mature products where default chat already has live, time-aware answers.

The target product behavior is:

- `chat` should have default live-search and real-time answer capability.
- `agent` should include everything `chat` can do, then add stronger execution and tool orchestration.
- User-configured MCP should remain an advanced extension, not the prerequisite for basic web access.

## Goals

- Make normal chat capable of answering time-sensitive questions by default.
- Route simple requests to the cheapest and most reliable live capability instead of always doing web search.
- Keep the live capability provider-independent so channel/model switching does not break product semantics.
- Make the UI clearly indicate whether a reply used local resolution, structured live data, web search, or no live capability.

## Non-Goals

- Full deep-research workflow in the first iteration.
- Replacing MCP as an advanced tool mechanism.
- Building user-managed search provider configuration in the first iteration.

## Capability Model

The product should expose two layers:

1. **Built-in default live capability**
   - Owned by the product backend.
   - Used automatically by `chat`.
   - Reused by `agent`.

2. **Advanced tools**
   - MCP and future custom tools.
   - Available primarily to `agent`.
   - Optional and user-configurable.

This changes the product semantics to:

- `chat` = default live-aware assistant
- `agent` = live-aware assistant + MCP + files + execution + multi-step workflows

## Query Routing

Introduce a server-side `QueryRouter` that classifies each request into one of these execution modes:

- `local`
- `structured_live`
- `web_search`
- `research`
- `direct_model`

### `local`

Use for deterministic requests such as:

- 今天周几
- 现在几点
- 时区换算
- 简单计算

Handling:

- Resolve on the server with local logic and current timezone context.
- Do not use web search.

### `structured_live`

Use for single-domain, structured, frequently changing facts such as:

- 今天天气
- 明天会不会下雨
- Other future structured live domains such as exchange rates or stock prices

Handling:

- Use a dedicated provider-specific service, not general web search.
- Return normalized structured data, then let the model phrase it naturally.

### `web_search`

Use for recent facts and current events such as:

- 最近发生了什么
- 今天的 AI 新闻
- 某公司最近发布了什么

Handling:

- Search first.
- Fetch and clean the top relevant pages.
- Summarize with citations.

### `research`

Use for multi-hop or synthesis-heavy requests such as:

- Compare recent funding, launches, or market shifts across multiple sources

Handling:

- Multi-round retrieval and synthesis.
- In `chat`, start with a lightweight version and allow future upgrade messaging.
- In `agent`, allow the full path plus MCP/tool augmentation.

### `direct_model`

Use for requests that do not need live context, such as:

- Writing help
- Translation
- General explanation
- Non-time-sensitive coding help

Handling:

- Skip live tooling.

## Backend Architecture

Add a built-in capability orchestration layer instead of scattering live logic inside `messageService` and `agentService`.

### Core services

- `QueryRouter`
  - Inputs: prompt, recent context, mode (`chat|agent`), user timezone, optional location hints
  - Output: route type, confidence, citation requirement, fallback allowance

- `LocalResolver`
  - Resolves deterministic questions without network access

- `WeatherService`
  - Encapsulates a weather provider and returns normalized weather data

- `SearchService`
  - Encapsulates live web/news search provider(s)
  - Returns normalized result metadata

- `ContentFetchService`
  - Fetches and cleans search result pages for model consumption

- `LiveContextAssembler`
  - Converts resolved live data into a consistent prompt/context package

- `CapabilityOrchestrator`
  - Shared entrypoint used by both `chat` and `agent`
  - Chooses route, gathers live context, and returns execution metadata

## Integration Boundaries

### Chat

`apps/server/src/services/messageService.ts` should call `CapabilityOrchestrator` before normal model streaming.

Expected behavior:

- `chat` gets default live awareness.
- It uses the lightest correct tool path for the question.
- It emits structured metadata for the UI so the user can see whether live capability was used.

### Agent

`apps/server/src/services/agentService.ts` should also call `CapabilityOrchestrator` before invoking MCP-backed agent execution.

Expected behavior:

- `agent` inherits all `chat` live capability.
- MCP remains additive, not foundational.

### MCP

MCP stays as an advanced extension surface:

- private data sources
- company tools
- custom workflows
- execution helpers

It is no longer the primary mechanism for default web connectivity.

## Runtime and Fallback Behavior

Fallback rules should be explicit:

- `local` failure may fall back to direct model response.
- `structured_live` and `web_search` failures must not silently pretend they used live data.
- If live providers are unavailable, the system should mark the answer as offline/degraded.
- `agent` can continue with MCP and execution even if a live provider is degraded.

## UI Behavior

The user should be able to tell what happened in each response.

Recommended message-level state:

- `已使用实时搜索`
- `已使用天气数据`
- `未联网，直接回答`
- `实时服务暂不可用，本轮为离线回答`

If web search or research is used:

- show citations/sources

If no default live provider is configured:

- surface a clear status in settings and chat
- do not hide the degraded state

## Settings Model

Separate built-in capability from advanced tools.

### Built-in default live capability

Configured by deployment/server environment, for example:

- `SEARCH_PROVIDER`
- `SEARCH_API_KEY`
- `WEATHER_PROVIDER`
- `WEATHER_API_KEY`
- `CONTENT_FETCH_PROVIDER`
- `CONTENT_FETCH_API_KEY`

This is product-owned and should be available without end-user configuration.

### Advanced tools

Existing MCP configuration remains in settings, but its product meaning changes from:

- "how chat gets web access"

to:

- "extra tools available to agent"

## Testing Strategy

Minimum first-pass coverage:

1. Query classification tests
   - local
   - structured live
   - web search
   - research
   - direct model

2. Service tests
   - Search provider success/failure
   - Weather provider success/failure
   - Fallback and degraded-state propagation

3. Integration tests
   - `chat` uses built-in live capability
   - `agent` inherits the same live capability
   - degraded states are surfaced correctly

4. UI tests or targeted component verification
   - live status labels render correctly
   - source/citation rendering appears when provided

## Rollout Plan

Recommended rollout order:

1. Build the routing and metadata shape.
2. Ship local resolution and weather first.
3. Add web search + content fetch for current-events questions.
4. Surface live/degraded state in chat UI.
5. Update settings copy to clarify built-in live capability vs MCP.

## Recommendation

Use a product-owned default live capability stack and keep it provider-independent.

For the first implementation slice:

- add `QueryRouter`
- add `LocalResolver`
- add `WeatherService`
- add response metadata for live/degraded states
- wire `chat` and `agent` through the same orchestrator interface

This provides the correct product direction while keeping the first change set small enough to validate quickly and adjust afterward.
