# Agent Settings Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add Agent settings UI with workspace management and global MCP configuration, while using the global default channel/model.

**Architecture:** Extend agent store with selected workspace, add AgentSettings UI, and pass workspaceId into agent sessions. Server resolves cwd from workspace and validates existence.

**Tech Stack:** Hono, Drizzle ORM, Next.js App Router, Mantine UI, Zustand.

---

### Task 1: Extend agent store for workspace selection

**Files:**
- Modify: `apps/web/src/stores/agentStore.ts`

**Step 1: Write the failing test**

```ts
import { useAgentStore } from "./agentStore";
const state = useAgentStore.getState();
if (state.selectedWorkspaceId === undefined) throw new Error("missing");
```

**Step 2: Run test to verify it fails**

Run: `node apps/web/src/stores/agentStore.test.ts`  
Expected: FAIL (field missing).

**Step 3: Write minimal implementation**

- Add `selectedWorkspaceId` + setter
- Ensure `setCurrentSession` does not clobber selection

**Step 4: Run test to verify it passes**

Run: `node apps/web/src/stores/agentStore.test.ts`  
Expected: PASS.

**Step 5: Commit**

```
git add apps/web/src/stores/agentStore.ts apps/web/src/stores/agentStore.test.ts
git commit -m "feat: add selected workspace state"
```

### Task 2: Build AgentSettings UI

**Files:**
- Create: `apps/web/src/components/settings/AgentSettings.tsx`
- Modify: `apps/web/src/app/settings/page.tsx`
- Modify: `apps/web/src/lib/api.ts` (if needed for mcp/workspaces)

**Step 1: Write the failing test**

```ts
import { AgentSettings } from "../components/settings/AgentSettings";
if (!AgentSettings) throw new Error("missing");
```

**Step 2: Run test to verify it fails**

Run: `node apps/web/src/components/settings/agent-settings.check.ts`  
Expected: FAIL initially.

**Step 3: Write minimal implementation**

- Load workspaces and MCP servers
- CRUD UI for both
- Workspace select dropdown + cwd input
- “No workspace” empty state

**Step 4: Manual verification**

- Add workspace, select it, set cwd
- Add MCP server, edit JSON config, toggle enable

**Step 5: Commit**

```
git add apps/web/src/components/settings/AgentSettings.tsx apps/web/src/app/settings/page.tsx apps/web/src/lib/api.ts
git commit -m "feat: add agent settings UI"
```

### Task 3: Pass workspaceId into agent sessions + validate on run

**Files:**
- Modify: `apps/web/src/app/agent/page.tsx`
- Modify: `apps/server/src/services/agentService.ts`

**Step 1: Write the failing test**

```ts
import { test, expect } from "bun:test";
import { resolveWorkspaceCwd } from "./agentService";
expect(resolveWorkspaceCwd(null)).toBeNull();
```

**Step 2: Run test to verify it fails**

Run: `cd apps/server && bun test src/services/agentService.test.ts`  
Expected: FAIL (missing export).

**Step 3: Write minimal implementation**

- When creating session, include selected `workspaceId`
- In `runAgent`, load workspace and pass `cwd` (if missing -> error)
- If no workspace selected, prevent run on client

**Step 4: Manual verification**

- Select workspace, run agent, confirm no error
- Without selection, button disabled and hint shown

**Step 5: Commit**

```
git add apps/web/src/app/agent/page.tsx apps/server/src/services/agentService.ts
git commit -m "feat: wire workspace into agent run"
```

---

## Notes

- Repo lacks git; commit steps are placeholders.
