# Tavily Live Search Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace degraded `web_search` and `research` routes with real Tavily-backed retrieval, plus citations and settings-based key override support.

**Architecture:** Add a small Tavily search service that resolves credentials from user settings or `TAVILY_API_KEY`, then extend the live capability orchestrator to attach search context and citations. Persist citations on assistant messages, stream them to the client, and expose a settings field for per-user Tavily override.

**Tech Stack:** Bun, Hono, TypeScript, Drizzle/SQLite, Zustand, Next.js, Tavily REST API, existing SSE chat stream.

---

### Task 1: Add Search Provider Settings And Message Citation Storage

**Files:**
- Modify: `packages/db/src/schema/index.ts`
- Modify: `apps/server/src/db/bootstrap.ts`
- Modify: `apps/web/src/lib/api.ts`
- Modify: `apps/web/src/stores/chatStore.ts`

**Step 1: Write the failing type/check expectation**

Add new fields in the shared API/store types:

- `ApiMessage.citations`
- message store `citations`

Expected failure: TypeScript complains that message objects from the server do not match the new type.

**Step 2: Run the check to verify it fails**

Run: `pnpm --filter web typecheck`
Expected: FAIL with missing `citations` fields/types.

**Step 3: Write minimal schema and type changes**

- add `citations` column to `messages`
- bootstrap old databases with `ALTER TABLE messages ADD COLUMN citations TEXT`
- extend API/store parsing to read/write citations JSON

**Step 4: Run the check to verify it passes**

Run: `pnpm --filter web typecheck`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/db/src/schema/index.ts apps/server/src/db/bootstrap.ts apps/web/src/lib/api.ts apps/web/src/stores/chatStore.ts
git commit -m "feat(db): add message citation storage"
```

### Task 2: Add Tavily Search Service

**Files:**
- Create: `apps/server/src/services/searchService.ts`
- Create: `apps/server/src/services/searchService.test.ts`
- Modify: `apps/server/src/services/settingsService.ts` only if helper reuse is needed

**Step 1: Write the failing test**

```ts
import { expect, test } from 'bun:test';
import { buildSearchContext } from './searchService';

test('buildSearchContext prefers user tavily key over env key', async () => {
  const result = await buildSearchContext({
    route: 'web_search',
    prompt: '最近 AI 圈有什么新闻',
    userSettings: { 'liveSearch.tavilyApiKey': 'user-key' },
    envKey: 'env-key',
    fetchImpl: async (input, init) => {
      expect((init?.headers as Record<string, string>)?.Authorization).toBe('Bearer user-key');
      return new Response(JSON.stringify({ results: [] }));
    },
  });

  expect(result.status).toBe('offline');
});
```

**Step 2: Run test to verify it fails**

Run: `bun test apps/server/src/services/searchService.test.ts`
Expected: FAIL because the service does not exist.

**Step 3: Write minimal implementation**

Implement:

- Tavily key selection: user setting first, env second
- request builder for `web_search` and `research`
- normalized output:
  - `status`
  - `label`
  - `systemContext`
  - `citations`

**Step 4: Run test to verify it passes**

Run: `bun test apps/server/src/services/searchService.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add apps/server/src/services/searchService.ts apps/server/src/services/searchService.test.ts
git commit -m "feat(server): add tavily search service"
```

### Task 3: Extend Live Capability Orchestrator For Tavily

**Files:**
- Modify: `apps/server/src/services/liveCapabilities.ts`
- Modify: `apps/server/src/services/liveCapabilities.test.ts`
- Modify: `apps/server/src/services/liveCapabilities.orchestrator.test.ts`

**Step 1: Write the failing test**

Add orchestrator tests that assert:

- `web_search` returns `status: 'live'` with citations when Tavily succeeds
- `research` returns `status: 'live'` with more retrieval context
- missing key returns `实时搜索未配置，本轮为离线回答`

**Step 2: Run tests to verify they fail**

Run: `bun test apps/server/src/services/liveCapabilities.test.ts apps/server/src/services/liveCapabilities.orchestrator.test.ts`
Expected: FAIL because `buildLiveContext` does not call Tavily.

**Step 3: Write minimal implementation**

- add `citations` to `LiveContextResult`
- inject settings/env/fetch dependencies into `buildLiveContext`
- call `SearchService` only for `web_search` and `research`

**Step 4: Run tests to verify they pass**

Run: `bun test apps/server/src/services/liveCapabilities.test.ts apps/server/src/services/liveCapabilities.orchestrator.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add apps/server/src/services/liveCapabilities.ts apps/server/src/services/liveCapabilities.test.ts apps/server/src/services/liveCapabilities.orchestrator.test.ts
git commit -m "feat(server): connect tavily to live query routing"
```

### Task 4: Stream And Persist Citations In Chat And Agent Responses

**Files:**
- Modify: `apps/server/src/services/messageService.ts`
- Modify: `apps/server/src/services/agentService.ts`
- Modify: `apps/server/src/services/messageService.live.test.ts`

**Step 1: Write the failing test**

Extend the SSE regression to assert event ordering:

1. `live_status`
2. `citations`
3. assistant `delta`

Also assert assistant messages persist `citations`.

**Step 2: Run test to verify it fails**

Run: `bun test apps/server/src/services/messageService.live.test.ts`
Expected: FAIL because no `citations` SSE event exists.

**Step 3: Write minimal implementation**

- add a new SSE event type: `citations`
- send it before model deltas when citations exist
- persist citations alongside `liveMetadata`
- pass live search context into agent prompts the same way chat already receives it

**Step 4: Run test to verify it passes**

Run: `bun test apps/server/src/services/messageService.live.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add apps/server/src/services/messageService.ts apps/server/src/services/agentService.ts apps/server/src/services/messageService.live.test.ts
git commit -m "feat(server): stream and store live search citations"
```

### Task 5: Add Tavily Settings UI And Client Citation Rendering

**Files:**
- Modify: `apps/web/src/components/settings/AgentSettings.tsx`
- Modify: `apps/web/src/lib/chat-stream.ts`
- Modify: `apps/web/src/components/ChatArea.tsx`
- Modify: `apps/web/src/lib/api.ts`
- Modify: `apps/web/src/stores/chatStore.ts`

**Step 1: Write the failing type/check expectation**

Add new SSE and store types:

- `citations` stream event
- message citation list

Expected failure: `pnpm --filter web typecheck` reports missing handlers/render fields.

**Step 2: Run the check to verify it fails**

Run: `pnpm --filter web typecheck`
Expected: FAIL

**Step 3: Write minimal implementation**

- add Tavily settings input and precedence copy
- parse `citations` SSE events
- attach citations to the currently streaming assistant message
- render a compact source list in the message bubble

**Step 4: Run the check to verify it passes**

Run: `pnpm --filter web typecheck`
Expected: PASS

**Step 5: Commit**

```bash
git add apps/web/src/components/settings/AgentSettings.tsx apps/web/src/lib/chat-stream.ts apps/web/src/components/ChatArea.tsx apps/web/src/lib/api.ts apps/web/src/stores/chatStore.ts
git commit -m "feat(web): show tavily citations and settings override"
```

### Task 6: Final Verification

**Files:**
- Modify: none unless fixes are needed

**Step 1: Run server tests**

Run: `bun test apps/server/src/services/searchService.test.ts apps/server/src/services/liveCapabilities.test.ts apps/server/src/services/liveCapabilities.orchestrator.test.ts apps/server/src/services/messageService.live.test.ts apps/server/src/routes/agent.run.test.ts apps/server/src/utils/sse.error-shape.test.ts`
Expected: PASS

**Step 2: Run web validation**

Run: `pnpm --filter web typecheck`
Expected: PASS

**Step 3: Run lint if config is repaired**

Run: `pnpm lint`
Expected: PASS, or known failure due to the existing Biome config mismatch

**Step 4: Commit final polish if needed**

```bash
git add apps/server/src/services/searchService.ts apps/server/src/services/liveCapabilities.ts apps/server/src/services/messageService.ts apps/web/src/components/ChatArea.tsx apps/web/src/components/settings/AgentSettings.tsx
git commit -m "feat: add tavily-backed live search"
```
