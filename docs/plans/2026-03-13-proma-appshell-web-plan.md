# Proma-aligned Web AppShell Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Refactor OpenHorn Web layout into Proma-style three-pane AppShell (left sessions, middle main, right workspace files) and add workspace file context injection for Chat + Agent.

**Architecture:** Replace the current AppShellSlot/aside mechanism with a fixed `AppShellLayout` that renders `LeftSidebar`, `MainPanel`, and `RightSidebar`. Add server-side workspace FS APIs (list/read) with strict path safety, and pass `workspaceId + contextPaths` into Chat/Agent run to inject “Project Context” as a system message at request time.

**Tech Stack:** Next.js App Router, React, Zustand, Radix UI wrappers (shadcn), Hono (server), Drizzle (db), Node fs/promises.

---

### Task 1: Introduce Proma-style AppShell skeleton (Web)

**Files:**
- Modify: `apps/web/src/components/app/AppShellLayout.tsx`
- Modify: `apps/web/src/app/(app)/layout.tsx`
- Modify: `apps/web/src/app/(app)/chat/page.tsx`
- Modify: `apps/web/src/app/(app)/agent/page.tsx`
- Modify: `apps/web/src/components/app/AppNav.tsx` (or deprecate)
- Delete (if unused): `apps/web/src/components/app/AppShellContext.tsx`
- Delete (if unused): `apps/web/src/components/app/AppShellSlot.tsx`

**Step 1: Create new layout structure**
- Render three columns with Proma-like panels:
  - Left: `LeftSidebar` (mode switch + list + gear)
  - Middle: page children (chat/agent/settings)
  - Right: `WorkspaceSidebar`

**Step 2: Move chat list into left**
- In `/chat`, stop passing `ChatAside` via `AppShellSlot` and render only `ChatArea`.

**Step 3: Move agent sessions list into left**
- Extract the sessions list UI from `apps/web/src/app/(app)/agent/page.tsx` into a component used by `LeftSidebar`.
- In agent main view, keep only the run/event UI.

**Step 4: Smoke check**
Run: `pnpm --filter web typecheck`
Expected: PASS

---

### Task 2: Add Workspace FS APIs on the server (list/read)

**Files:**
- Modify: `apps/server/src/routes/workspace.ts`
- Create: `apps/server/src/services/workspaceFsService.ts` (safe path resolution + list/read helpers)
- Modify: `apps/server/src/index.ts` (only if a new route file is introduced)

**Step 1: Implement safe path resolution**
- Ensure `resolvedPath` stays within `workspace.cwd` (no `..`, no symlink escape).

**Step 2: Add endpoints**
- `GET /workspaces/:id/fs/list?path=...`
- `GET /workspaces/:id/fs/read?path=...` (truncate; text-only)

**Step 3: Verify**
Run: `pnpm --filter server typecheck` (or equivalent)
Expected: PASS

---

### Task 3: Build WorkspaceSidebar UI (file tree + preview + context selection)

**Files:**
- Create: `apps/web/src/components/workspace/WorkspaceSidebar.tsx`
- Create: `apps/web/src/components/workspace/WorkspaceFileTree.tsx`
- Create: `apps/web/src/components/workspace/WorkspacePreview.tsx`
- Create: `apps/web/src/stores/contextStore.ts` (persist: selected workspace + per-conversation/session contextPaths)
- Modify: `apps/web/src/lib/api.ts` (add workspace fs methods)

**Step 1: Workspace selector**
- Load `api.workspaces.list()` and store `selectedWorkspaceId`.

**Step 2: File tree**
- Fetch `fs/list` lazily per directory expansion.
- Display selection state for contextPaths.

**Step 3: Preview**
- On file click, fetch `fs/read` and render text preview (truncate + monospace).

**Step 4: Smoke check**
Run: `pnpm --filter web typecheck`
Expected: PASS

---

### Task 4: Inject “Project Context” into Chat stream

**Files:**
- Modify: `apps/web/src/components/ChatArea.tsx`
- Modify: `apps/web/src/lib/chat-stream.ts`
- Modify: `apps/web/src/lib/api.ts` (messages.stream supports context)
- Modify: `apps/server/src/routes/messages.ts`
- Modify: `apps/server/src/services/messageService.ts`
- Modify: `apps/server/src/services/agent-adapters/*` (only if needed; prefer messageService injection)

**Step 1: API shape**
- Add to stream request: `workspaceId?: string; contextPaths?: string[]`

**Step 2: Server injection**
- Build context text from `workspaceId + contextPaths` via `workspaceFsService`.
- Inject as `system` message near the top of `chatMessages` for the request.
- Enforce size limits and surface meaningful errors.

**Step 3: UI integration**
- In `ChatArea` send handler, read contextPaths for current conversation and include in stream request.
- Show context chips in the composer footer; allow remove/clear.

**Step 4: Verify**
Run: `pnpm --filter web build`
Expected: PASS

---

### Task 5: Inject context into Agent run

**Files:**
- Modify: `apps/web/src/app/(app)/agent/page.tsx` (include contextPaths in run request)
- Modify: `apps/server/src/routes/agent.ts` (accept `contextPaths`)
- Modify: `apps/server/src/services/agentService.ts` (read workspace files by relative paths; prepend to prompt/system)

**Step 1: API + server**
- Pass `contextPaths` into `runAgent` and inject using session effective workspace cwd.

**Step 2: Verify**
Run: `pnpm --filter web typecheck`
Expected: PASS

---

### Task 6: Composer bottom toolbar (Proma-like)

**Files:**
- Modify: `apps/web/src/components/ChatArea.tsx`
- Create: `apps/web/src/components/chat/ChatComposerToolbar.tsx`

**Step 1: Add toolbar row**
- Render model label + icons (Attach, Context summary).
- Keep interactions minimal and stable.

**Step 2: Verify**
Run: `pnpm --filter web build`
Expected: PASS

