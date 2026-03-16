# Chat Default Live Search Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make normal chat default to product-owned live capability, and make agent inherit the same live capability before its extra tool execution.

**Architecture:** Add a small server-side live capability layer with a query router, local/time resolver, and pluggable weather provider. Thread structured live metadata through chat streaming and stored messages so the web UI can show whether a reply used local data, weather data, live search, or degraded offline fallback. Keep MCP as an advanced agent-only extension surface.

**Tech Stack:** Bun, Hono, TypeScript, Drizzle/SQLite, Zustand, Next.js, existing SSE chat stream.

---

### Task 1: Add Live Capability Types And Query Router

**Files:**
- Create: `apps/server/src/services/liveCapabilities.ts`
- Create: `apps/server/src/services/liveCapabilities.test.ts`

**Step 1: Write the failing test**

```ts
import { expect, test } from 'bun:test';
import { routeLiveQuery } from './liveCapabilities';

test('routeLiveQuery classifies local time questions', () => {
  expect(routeLiveQuery('今天周几')).toEqual({
    type: 'local',
    needsCitation: false,
  });
});

test('routeLiveQuery classifies weather questions', () => {
  expect(routeLiveQuery('今天天气怎么样').type).toBe('structured_live');
});

test('routeLiveQuery classifies recent-news questions', () => {
  expect(routeLiveQuery('最近 AI 圈有什么新闻').type).toBe('web_search');
});

test('routeLiveQuery leaves non-live prompts as direct model', () => {
  expect(routeLiveQuery('把这段话翻译成英文').type).toBe('direct_model');
});
```

**Step 2: Run test to verify it fails**

Run: `bun test apps/server/src/services/liveCapabilities.test.ts`
Expected: FAIL with module or symbol not found.

**Step 3: Write minimal implementation**

```ts
export type LiveRouteType =
  | 'local'
  | 'structured_live'
  | 'web_search'
  | 'research'
  | 'direct_model';

export function routeLiveQuery(prompt: string) {
  const text = prompt.trim();
  if (/周几|星期|几点|几号|日期|时间/.test(text)) {
    return { type: 'local' as const, needsCitation: false };
  }
  if (/天气|下雨|气温|温度/.test(text)) {
    return { type: 'structured_live' as const, needsCitation: false };
  }
  if (/最近|今天.*新闻|最新|刚刚|发布了什么|发生了什么/.test(text)) {
    return { type: 'web_search' as const, needsCitation: true };
  }
  if (/比较|分析|调研|汇总|整理.*最近/.test(text)) {
    return { type: 'research' as const, needsCitation: true };
  }
  return { type: 'direct_model' as const, needsCitation: false };
}
```

**Step 4: Run test to verify it passes**

Run: `bun test apps/server/src/services/liveCapabilities.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add apps/server/src/services/liveCapabilities.ts apps/server/src/services/liveCapabilities.test.ts
git commit -m "feat(server): add live query router"
```

### Task 2: Add Local Resolver, Weather Service, And Orchestrator

**Files:**
- Modify: `apps/server/src/services/liveCapabilities.ts`
- Create: `apps/server/src/services/liveCapabilities.orchestrator.test.ts`

**Step 1: Write the failing test**

```ts
import { expect, test } from 'bun:test';
import { buildLiveContext } from './liveCapabilities';

test('buildLiveContext resolves weekday locally', async () => {
  const result = await buildLiveContext({
    prompt: '今天周几',
    now: new Date('2026-03-16T09:00:00+08:00'),
    timezone: 'Asia/Shanghai',
  });

  expect(result.status).toBe('live');
  expect(result.source.type).toBe('local');
  expect(result.userLabel).toContain('本地时间');
  expect(result.systemContext).toContain('Monday');
});
```

**Step 2: Run test to verify it fails**

Run: `bun test apps/server/src/services/liveCapabilities.orchestrator.test.ts`
Expected: FAIL because `buildLiveContext` does not exist.

**Step 3: Write minimal implementation**

```ts
export interface LiveContextResult {
  status: 'live' | 'offline';
  route: LiveRouteType;
  userLabel: string;
  source: { type: 'local' | 'weather' | 'web_search' | 'none' };
  systemContext?: string;
}

export async function buildLiveContext(input: {
  prompt: string;
  timezone?: string;
  now?: Date;
}) {
  const route = routeLiveQuery(input.prompt);
  if (route.type === 'local') {
    const now = input.now ?? new Date();
    const weekday = new Intl.DateTimeFormat('en-US', {
      weekday: 'long',
      timeZone: input.timezone || 'Asia/Shanghai',
    }).format(now);

    return {
      status: 'live' as const,
      route: route.type,
      userLabel: '已使用本地时间',
      source: { type: 'local' as const },
      systemContext: `Current weekday: ${weekday}`,
    };
  }

  return {
    status: 'offline' as const,
    route: route.type,
    userLabel: '未联网，直接回答',
    source: { type: 'none' as const },
  };
}
```

**Step 4: Run test to verify it passes**

Run: `bun test apps/server/src/services/liveCapabilities.orchestrator.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add apps/server/src/services/liveCapabilities.ts apps/server/src/services/liveCapabilities.orchestrator.test.ts
git commit -m "feat(server): add live context orchestrator"
```

### Task 3: Thread Live Metadata Through Chat And Agent Streaming

**Files:**
- Modify: `apps/server/src/services/messageService.ts`
- Modify: `apps/server/src/services/agentService.ts`
- Modify: `apps/server/src/routes/messages.ts`
- Create: `apps/server/src/services/messageService.live.test.ts`

**Step 1: Write the failing test**

```ts
import { expect, mock, test } from 'bun:test';

test('stream chat emits live status metadata before assistant deltas', async () => {
  mock.module('./liveCapabilities', () => ({
    buildLiveContext: async () => ({
      status: 'live',
      route: 'local',
      userLabel: '已使用本地时间',
      source: { type: 'local' },
      systemContext: 'Current weekday: Monday',
    }),
  }));

  // import streamMessage and assert SSE events include:
  // { type: 'live_status', status: 'live', label: '已使用本地时间', route: 'local' }
});
```

**Step 2: Run test to verify it fails**

Run: `bun test apps/server/src/services/messageService.live.test.ts`
Expected: FAIL because no `live_status` SSE event exists.

**Step 3: Write minimal implementation**

```ts
type LiveStatusPayload = {
  status: 'live' | 'offline';
  route: 'local' | 'structured_live' | 'web_search' | 'research' | 'direct_model';
  label: string;
};

send({
  type: 'live_status',
  status: liveContext.status,
  route: liveContext.route,
  label: liveContext.userLabel,
});
```

Also append `liveContext.systemContext` into chat model messages when present, and pass the same live context into `runAgentWithConfig` so agent inherits it.

**Step 4: Run test to verify it passes**

Run: `bun test apps/server/src/services/messageService.live.test.ts`
Expected: PASS

**Step 5: Run a focused regression test set**

Run: `bun test apps/server/src/routes/agent.run.test.ts apps/server/src/utils/sse.error-shape.test.ts`
Expected: PASS

**Step 6: Commit**

```bash
git add apps/server/src/services/messageService.ts apps/server/src/services/agentService.ts apps/server/src/routes/messages.ts apps/server/src/services/messageService.live.test.ts
git commit -m "feat(server): stream live capability metadata"
```

### Task 4: Render Live Status In Web Chat UI

**Files:**
- Modify: `apps/web/src/lib/chat-stream.ts`
- Modify: `apps/web/src/lib/api.ts`
- Modify: `apps/web/src/stores/chatStore.ts`
- Modify: `apps/web/src/components/ChatArea.tsx`

**Step 1: Write the failing UI/data test or check**

```ts
// If adding a store test is cheap, assert that a live status event updates
// the current streaming assistant message metadata.
// Otherwise add a small check file and verify TypeScript catches missing types.
```

**Step 2: Run the check to verify it fails**

Run: `pnpm --filter web typecheck`
Expected: FAIL after adding `live_status` handling types but before wiring store/UI support.

**Step 3: Write minimal implementation**

```ts
type ChatStreamEvent =
  | { type: 'live_status'; status: 'live' | 'offline'; route: string; label: string }
  | { type: 'delta'; content: string }
  | { type: 'done'; messageId?: string; model?: string; agentRun?: ApiAgentRun }
  | { type: 'agent_event'; event: { type: string; content?: string; toolName?: string; toolInput?: unknown } }
  | { type: 'error'; message: string };
```

Add message metadata fields such as:

```ts
liveStatus?: 'live' | 'offline';
liveRoute?: 'local' | 'structured_live' | 'web_search' | 'research' | 'direct_model';
liveLabel?: string;
```

Render a compact badge above assistant content when present.

**Step 4: Run typecheck to verify it passes**

Run: `pnpm --filter web typecheck`
Expected: PASS

**Step 5: Commit**

```bash
git add apps/web/src/lib/chat-stream.ts apps/web/src/lib/api.ts apps/web/src/stores/chatStore.ts apps/web/src/components/ChatArea.tsx
git commit -m "feat(web): show live capability status in chat"
```

### Task 5: Clarify Settings Copy For Built-In Live Capability Vs MCP

**Files:**
- Modify: `apps/web/src/components/settings/AgentSettings.tsx`

**Step 1: Write the smallest failing verification**

```ts
// Use typecheck as the guard if no UI test harness exists.
// The important part is that settings copy reflects the new product model.
```

**Step 2: Update copy and structure**

Implement:

- a “默认联网能力” section with deployment-owned status text
- an “高级工具（MCP）” section describing MCP as additive agent tooling

Suggested copy:

```tsx
<SettingsSection
  title="默认联网能力"
  description="普通聊天默认使用产品内置的实时能力；Agent 在此基础上叠加更多工具。"
/>
```

**Step 3: Run validation**

Run: `pnpm --filter web typecheck`
Expected: PASS

**Step 4: Commit**

```bash
git add apps/web/src/components/settings/AgentSettings.tsx
git commit -m "chore(web): clarify built-in live capability settings"
```

### Task 6: Final Verification

**Files:**
- Modify: none unless fixes are needed

**Step 1: Run server tests**

Run: `bun test apps/server/src/services/liveCapabilities.test.ts apps/server/src/services/liveCapabilities.orchestrator.test.ts apps/server/src/services/messageService.live.test.ts apps/server/src/routes/agent.run.test.ts apps/server/src/utils/sse.error-shape.test.ts`
Expected: PASS

**Step 2: Run web validation**

Run: `pnpm --filter web typecheck`
Expected: PASS

**Step 3: Run lint if touched code needs formatting**

Run: `pnpm lint`
Expected: PASS or only pre-existing unrelated issues

**Step 4: Commit final polish if needed**

```bash
git add apps/server/src/services/liveCapabilities.ts apps/server/src/services/messageService.ts apps/server/src/services/agentService.ts apps/web/src/lib/chat-stream.ts apps/web/src/stores/chatStore.ts apps/web/src/components/ChatArea.tsx apps/web/src/components/settings/AgentSettings.tsx
git commit -m "feat: add default live capability for chat"
```
