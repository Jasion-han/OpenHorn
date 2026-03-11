# Agent Default Workspace (Account-Level) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add an account-level default workspace setting for Agent that syncs across devices and is applied immediately when changed.

**Architecture:** Store default workspace id in `settings` table (`agent.defaultWorkspaceId`) and expose minimal `/settings` API. Web reads/writes this setting on Agent page and reuses it in Settings. Server agent session creation/run uses this setting as a fallback when `workspaceId` is missing.

**Tech Stack:** Hono (server routes), Drizzle ORM + libsql/SQLite, Next.js + Mantine (web), Zustand (state), bun:test (tests)

---

### Task 1: Add Settings Service (Server)

**Files:**
- Create: `apps/server/src/services/settingsService.ts`
- Modify: `apps/server/src/db/bootstrap.ts` (optional: ensure table exists already)
- Test: `apps/server/src/services/settingsService.test.ts`

**Step 1: Write failing tests**

Create `apps/server/src/services/settingsService.test.ts`:

```ts
import { test, expect } from 'bun:test';
import { setSettingValue, getSettingValues, deleteSettingValue } from './settingsService';

test('settings: set/get/delete value by key', async () => {
  const userId = crypto.randomUUID();
  const key = 'agent.defaultWorkspaceId';
  await setSettingValue(userId, key, 'ws1');
  expect(await getSettingValues(userId, [key])).toEqual({ [key]: 'ws1' });
  await deleteSettingValue(userId, key);
  expect(await getSettingValues(userId, [key])).toEqual({});
});

test('settings: user isolation', async () => {
  const key = 'agent.defaultWorkspaceId';
  await setSettingValue('u1', key, 'ws_u1');
  await setSettingValue('u2', key, 'ws_u2');
  expect(await getSettingValues('u1', [key])).toEqual({ [key]: 'ws_u1' });
  expect(await getSettingValues('u2', [key])).toEqual({ [key]: 'ws_u2' });
});
```

**Step 2: Run tests (expect fail)**

Run:
```bash
bun test apps/server/src/services/settingsService.test.ts
```
Expected: FAIL (module/functions not found).

**Step 3: Implement minimal settings service**

Create `apps/server/src/services/settingsService.ts`:

```ts
import { db } from '../db';
import { settings } from 'db';
import { and, eq, inArray } from 'drizzle-orm';
import { generateId } from '../utils';

export async function getSettingValues(userId: string, keys: string[]) {
  if (!Array.isArray(keys) || keys.length === 0) return {};
  const rows = await db.select().from(settings)
    .where(and(eq(settings.userId, userId), inArray(settings.key, keys)));

  const out: Record<string, string> = {};
  for (const row of rows) out[row.key] = row.value;
  return out;
}

export async function setSettingValue(userId: string, key: string, value: string) {
  const now = new Date();
  await db.delete(settings).where(and(eq(settings.userId, userId), eq(settings.key, key)));
  await db.insert(settings).values({
    id: generateId(),
    userId,
    key,
    value,
    updatedAt: now,
  });
}

export async function deleteSettingValue(userId: string, key: string) {
  await db.delete(settings).where(and(eq(settings.userId, userId), eq(settings.key, key)));
}
```

**Step 4: Re-run tests (expect pass)**

Run:
```bash
bun test apps/server/src/services/settingsService.test.ts
```
Expected: PASS.

**Step 5: Commit**

```bash
git add apps/server/src/services/settingsService.ts apps/server/src/services/settingsService.test.ts
git commit -m "feat(server): add user settings service"
```

---

### Task 2: Add Settings Routes (Server)

**Files:**
- Create: `apps/server/src/routes/settings.ts`
- Modify: `apps/server/src/index.ts`
- Test: `apps/server/src/routes/settings.test.ts`

**Step 1: Write failing tests**

Create `apps/server/src/routes/settings.test.ts` (minimal API-level test by calling fetch handler is optional; if too heavy, skip and rely on service tests).

**Step 2: Implement routes**

Create `apps/server/src/routes/settings.ts`:
- `GET /settings?keys=a,b` returns `{ settings: { ... } }`
- `PUT /settings/:key` with `{ value: string | null }`

Implementation notes:
- Use the same cookie auth helper pattern as other routes (`verifyToken + getUserById`)
- For `keys` parsing: split by comma, trim, filter empty
- For `PUT`: if `value === null`, delete; if string, set

**Step 3: Wire route**

Modify `apps/server/src/index.ts`:
- `import settingsRoutes from './routes/settings'`
- `app.route('/settings', settingsRoutes)`

**Step 4: Manual test**

Run server and curl (with cookies) or test from web after frontend is updated.

**Step 5: Commit**

```bash
git add apps/server/src/routes/settings.ts apps/server/src/index.ts
git commit -m "feat(server): add settings API"
```

---

### Task 3: Add Settings API Client (Web)

**Files:**
- Modify: `apps/web/src/lib/api.ts`

**Step 1: Add API types**
- `ApiSettingsMap = Record<string, string>`

**Step 2: Add endpoints**
- `api.settings.get(keys: string[])`
- `api.settings.set(key: string, value: string | null)`

**Step 3: Typecheck**

Run:
```bash
pnpm --filter web typecheck
```

**Step 4: Commit**

```bash
git add apps/web/src/lib/api.ts
git commit -m "feat(web): add settings API client"
```

---

### Task 4: Agent Page Workspace Picker + Auto Save (Web)

**Files:**
- Modify: `apps/web/src/app/(app)/agent/page.tsx`
- Modify: `apps/web/src/stores/agentStore.ts`
- (Optional) Modify: `apps/web/src/components/settings/AgentSettings.tsx` to reuse store state and remove duplicate fetching

**Step 1: Split inputs**
- Replace shared `input` into:
  - `newSessionTitle`
  - `taskInput`

**Step 2: Load workspaces + default setting on Agent page**
- On mount:
  - fetch `workspaces.list()`
  - fetch `settings.get(['agent.defaultWorkspaceId'])`
- Decide selected workspace:
  - use setting if exists and valid
  - else pick first workspace and write back

**Step 3: Add Workspace Select UI**
- Add `<Select>` above the events pane (right column)
- On change:
  - optimistic `setSelectedWorkspaceId`
  - call `api.settings.set('agent.defaultWorkspaceId', value)`
  - on failure: rollback and show notification

**Step 4: Remove alerts**
- Replace `alert(...)` usage in Agent flows with `notifyError/notifySuccess`

**Step 5: Fix session list state duplication**
- Remove `sessionsList` local state and use store `sessions`
- Add a `loadSessions` that writes into store via `setSessions`

**Step 6: Commit**

```bash
git add apps/web/src/app/(app)/agent/page.tsx apps/web/src/stores/agentStore.ts
git commit -m "feat(web): agent workspace picker with account-level default"
```

---

### Task 5: Server Fallback: Use Default Workspace When Missing

**Files:**
- Modify: `apps/server/src/services/agentService.ts`

**Step 1: Implement fallback in create/run**
- In `createAgentSession`: if no `workspaceId`, load `agent.defaultWorkspaceId` and set it (if exists and owned by user)
- In `runAgent`: if session has no `workspaceId`, use default from settings; optionally update session row

**Step 2: Manual test**
- Create session without workspaceId (simulate older clients) and verify run uses default workspace.

**Step 3: Commit**

```bash
git add apps/server/src/services/agentService.ts
git commit -m "feat(server): agent uses default workspace setting as fallback"
```

---

### Task 6: Replace Alerts in AgentSettings (Web)

**Files:**
- Modify: `apps/web/src/components/settings/AgentSettings.tsx`

**Steps:**
- Replace `alert(...)` with `notifyError/notifySuccess`
- (Optional) Reuse `useAgentStore().workspaces` and `setWorkspaces` to avoid duplicate workspace state

**Commit:**

```bash
git add apps/web/src/components/settings/AgentSettings.tsx
git commit -m "refactor(web): use notifications in agent settings"
```

---

### Task 7: Verification

**Checks:**
- `bun test`
- `pnpm --filter web typecheck`
- Manual:
  - Login -> Agent page shows Workspace select even if never opened Settings
  - Switching workspace immediately affects new sessions and is remembered after logout/login
  - If setting points to deleted workspace, it auto-falls back to first workspace and saves

