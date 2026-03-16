# Tavily Live Search Design

**Context**

OpenHorn already has a built-in live capability router, but `web_search` and `research` still degrade to offline mode. The next step is to add a real product-owned search provider without changing the semantics of `local` and `structured_live`.

The chosen provider for the first iteration is Tavily.

## Goals

- Make `web_search` queries use real network retrieval by default.
- Make `research` queries use a broader Tavily retrieval pass than `web_search`.
- Keep `local` and `structured_live` semantics unchanged.
- Let deployment owners provide a global Tavily key while also allowing a per-user override key.
- Preserve explicit degraded behavior when no usable Tavily key exists or the provider fails.
- Surface citations in streaming and persisted messages so the web UI can show sources after refresh.

## Non-Goals

- Deep multi-round autonomous research.
- Replacing structured providers like weather with generic web search.
- Building provider selection UI for multiple search vendors.
- Fetching and cleaning each search result page in the first iteration.

## Product Semantics

- `local`: server-side deterministic resolution only.
- `structured_live`: only dedicated structured providers; never fall back to Tavily.
- `web_search`: lightweight Tavily retrieval for recent facts and current events.
- `research`: broader Tavily retrieval with stronger synthesis instructions, but still single-pass in v1.
- `direct_model`: no live retrieval.

This preserves a hard boundary: search results are not treated as structured real-time data.

## Provider Selection

The backend should select Tavily credentials in this order:

1. User setting `liveSearch.tavilyApiKey`
2. Server environment variable `TAVILY_API_KEY`
3. No key available -> degrade to offline mode

The UI should explain this precedence clearly. User-provided keys override the deployment default.

## Backend Architecture

Add a dedicated `SearchService` that is used only by the live capability orchestrator.

### `SearchService`

Responsibilities:

- choose the effective Tavily API key
- build Tavily request parameters based on route type
- normalize results into a provider-independent shape
- return structured citations for storage and UI

### `LiveCapabilityOrchestrator`

Extend the existing `buildLiveContext` flow:

- `web_search` -> call `SearchService.search('web_search')`
- `research` -> call `SearchService.search('research')`
- on success, return `status: 'live'`, `source.type: 'web_search'`, `systemContext`, and `citations`
- on failure or missing key, return explicit offline/degraded metadata

## Tavily Request Strategy

### `web_search`

- use Tavily search with a moderate result count
- optimize for fresh high-signal results
- feed the normalized results directly to the model

### `research`

- use Tavily search with a larger result count than `web_search`
- instruct the model to synthesize across multiple sources
- still stay single-pass in v1

The key difference is retrieval breadth and summarization instructions, not a separate autonomous workflow.

## Message And Streaming Model

Assistant messages should store:

- `liveMetadata`
- `citations`

Streaming should emit:

- `live_status`
- `citations` when present
- normal response deltas

This lets the UI show source links immediately and recover them after a page reload.

## UI Behavior

For `web_search` and `research`:

- show the existing live status badge
- render a compact citations block above the assistant content
- keep the UI resilient when citations are missing or partial

For settings:

- add a “默认联网搜索（Tavily）” section
- explain that user key overrides deployment default
- do not expose the server global key value

## Failure Behavior

- missing key -> `实时搜索未配置，本轮为离线回答`
- Tavily request failure -> `实时搜索暂不可用，本轮为离线回答`
- empty result set -> same degraded behavior, without pretending a search succeeded

The model prompt must explicitly forbid claiming live retrieval when the provider did not produce usable results.

## Testing

- unit tests for Tavily key selection and result normalization
- orchestrator tests for `web_search` and `research`
- message streaming test for `live_status` + `citations` ordering
- web typecheck for citations event/store/UI wiring

## Rollout

This should ship as a provider-backed replacement for the current degraded `web_search` and `research` paths, with no behavior change for `local` and `structured_live`.
