# Backend Connectivity Banner Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a persistent offline indicator + retry in the header, dedupe network-error toasts, and trigger soft refresh after backend recovery.

**Architecture:** A small global `backendStatus` store tracks connectivity; `fetchApi` updates it for network failures vs HTTP responses. `Retry` runs a health check and emits a global `backend-up` event that pages listen to and refetch their data.

**Tech Stack:** Next.js (App Router), Mantine, Zustand, TypeScript.

---

### Task 1: Add A Toast Dedupe Helper

**Files:**
- Modify: `apps/web/src/lib/notify.ts`

**Step 1: Add `notifyErrorOnce()`**
- Add a `Map<string, number>` to store last-shown timestamps.
- Provide `notifyErrorOnce(key, title, message, ttlMs = 10_000)`.

```ts
const lastShown = new Map<string, number>();

export function notifyErrorOnce(key: string, title: string, message: string, ttlMs = 10_000) {
  const now = Date.now();
  const prev = lastShown.get(key) ?? 0;
  if (now - prev < ttlMs) return;
  lastShown.set(key, now);
  notifications.show({ id: key, color: 'red', title, message });
}
```

**Step 2: Typecheck**
- Run: `pnpm --filter web typecheck`
- Expected: PASS

**Step 3: Commit**
```bash
git add apps/web/src/lib/notify.ts
git commit -m "feat(web): dedupe network error notifications"
```

### Task 2: Add Backend Status Store + Retry

**Files:**
- Create: `apps/web/src/stores/backendStatusStore.ts`

**Step 1: Implement store**
- State: `status`, `lastError`, `lastDownAt`, `lastUpAt`
- Actions: `markDown`, `markUp`, `retry`
- Constants: `BACKEND_UP_EVENT = 'openhorn:backend-up'`

```ts
export const BACKEND_UP_EVENT = 'openhorn:backend-up';
export const HEALTH_URL = 'http://localhost:3000/';
```

`retry()` should:
- call `fetch(HEALTH_URL, { method: 'GET' })`
- if ok: `markUp()` then `window.dispatchEvent(new Event(BACKEND_UP_EVENT))`
- return boolean success

**Step 2: Typecheck**
- Run: `pnpm --filter web typecheck`
- Expected: PASS

**Step 3: Commit**
```bash
git add apps/web/src/stores/backendStatusStore.ts
git commit -m "feat(web): track backend connectivity with retry"
```

### Task 3: Update `fetchApi` To Mark Backend Down And Dedupe Toasts

**Files:**
- Modify: `apps/web/src/lib/api.ts`
- Modify: `apps/web/src/lib/notify.ts`

**Step 1: Wrap the `fetch()` call**
- On network exception:
  - call `useBackendStatusStore.getState().markDown(...)` (store should expose `getState`)
  - call `notifyErrorOnce('backend_down', '后端不可用', '无法连接到 http://localhost:3000')`
  - rethrow the original error (or throw a normalized error)
- On any HTTP response received:
  - call `markUp()` (backend is reachable)

**Step 2: Ensure 401/4xx/5xx still throw business errors**
- Keep current JSON `{ error }` parsing behavior.

**Step 3: Typecheck**
- Run: `pnpm --filter web typecheck`
- Expected: PASS

**Step 4: Commit**
```bash
git add apps/web/src/lib/api.ts apps/web/src/lib/notify.ts
git commit -m "fix(web): mark backend offline on network failures"
```

### Task 4: Show Offline Banner + Retry In Header

**Files:**
- Modify: `apps/web/src/components/app/AppHeader.tsx`

**Step 1: Render offline UI**
- When `status === 'down'`:
  - show a red badge or small alert (avoid taking too much height)
  - show `Retry` button
- Clicking `Retry`:
  - disable while pending
  - on success: show `notifySuccess('连接已恢复', '已重新连接后端')`
  - on failure: keep offline UI and show one deduped error (optional)

**Step 2: Manual verify**
- Stop server: offline UI appears.
- Start server: click retry, UI returns to normal.

**Step 3: Commit**
```bash
git add apps/web/src/components/app/AppHeader.tsx
git commit -m "feat(web): header offline banner with retry"
```

### Task 5: Soft Refresh Listeners (No Full Reload)

**Files:**
- Modify: `apps/web/src/components/auth/AuthBootstrap.tsx`
- Modify: `apps/web/src/components/settings/ChannelSettings.tsx`
- Modify: `apps/web/src/components/settings/AgentSettings.tsx`
- Modify: `apps/web/src/components/chat/ChatAside.tsx`
- Modify: `apps/web/src/app/(app)/agent/page.tsx`

**Step 1: Add `backend-up` listener and refetch**
- For each component that already has a load function, add:

```ts
useEffect(() => {
  const onUp = () => { void loadFn(); };
  window.addEventListener(BACKEND_UP_EVENT, onUp);
  return () => window.removeEventListener(BACKEND_UP_EVENT, onUp);
}, [loadFn]);
```

`AuthBootstrap` should refetch `me` and `channels` to resync header state without navigating.

**Step 2: Manual verify**
- With server down, open Settings: no toast spam.
- Bring server back, click Retry: Channels/Workspaces/Sessions repopulate automatically.
- Chat input is not cleared (no full reload).

**Step 3: Commit**
```bash
git add apps/web/src/components/auth/AuthBootstrap.tsx apps/web/src/components/settings/ChannelSettings.tsx apps/web/src/components/settings/AgentSettings.tsx apps/web/src/components/chat/ChatAside.tsx apps/web/src/app/(app)/agent/page.tsx
git commit -m "feat(web): soft refresh data after backend recovery"
```

### Task 6: Verification And Guardrails

**Files:**
- Modify: `docs/plans/2026-03-12-backend-connectivity-banner-verify.md`

**Step 1: Write a short verify doc**
- Include commands:
  - `pnpm dev:server`
  - `pnpm dev:web`
- Include manual steps to reproduce down/up behavior.

**Step 2: Commit**
```bash
git add docs/plans/2026-03-12-backend-connectivity-banner-verify.md
git commit -m "docs: add backend connectivity verify steps"
```

