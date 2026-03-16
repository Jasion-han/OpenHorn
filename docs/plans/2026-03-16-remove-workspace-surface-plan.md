# Remove Workspace Surface Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Remove all workspace/workspace-context product surface from the web app so chat, agent, and settings no longer expose or depend on workspace UX.

**Architecture:** Strip workspace from the web product layer first: remove the right sidebar, settings tab/management UI, chat context controls, and agent workspace affordances. Keep server routes and persisted schema in place as compatibility scaffolding for now, but stop the web client from reading, writing, or displaying workspace state.

**Tech Stack:** Next.js App Router, React, Zustand, TypeScript, Tailwind, Hono API client bindings

---

### Task 1: Remove workspace UI shells

**Files:**
- Modify: `apps/web/src/components/app/AppShellLayout.tsx`
- Modify: `apps/web/src/components/app/RightSidebar.tsx`
- Modify: `apps/web/src/app/(app)/settings/page.tsx`

**Step 1: Remove the desktop/mobile right sidebar shell**

Update `AppShellLayout` so it renders only the left sidebar and main panel.

**Step 2: Remove the settings tab entry**

Delete the workspace/config tab from the settings page and stop routing `tab=workspace` / `tab=agent` into a visible section.

**Step 3: Run targeted typecheck**

Run: `pnpm --dir apps/web typecheck`
Expected: fail only on remaining workspace references outside these files.

### Task 2: Remove workspace management from settings and agent list

**Files:**
- Modify: `apps/web/src/components/settings/AgentSettings.tsx`
- Modify: `apps/web/src/components/agent/AgentSessionsAside.tsx`
- Modify: `apps/web/src/stores/agentStore.ts`

**Step 1: Remove workspace loading and selection from Agent settings**

Keep only default channel display and MCP management.

**Step 2: Remove workspace gating/labels from the agent session sidebar**

Creating/selecting sessions should no longer depend on a workspace list, and session rows should stop rendering workspace badges/text.

**Step 3: Simplify agent store**

Delete `workspaces` and `selectedWorkspaceId` state plus related actions/types.

### Task 3: Remove workspace context from chat flows

**Files:**
- Modify: `apps/web/src/components/ChatArea.tsx`
- Modify: `apps/web/src/components/composer/PromaComposer.tsx`
- Modify: `apps/web/src/stores/chatStore.ts`
- Delete: `apps/web/src/components/workspace/WorkspaceSidebar.tsx`
- Delete: `apps/web/src/components/workspace/WorkspaceFileTree.tsx`
- Delete: `apps/web/src/components/workspace/WorkspacePreview.tsx`
- Delete: `apps/web/src/stores/contextStore.ts`
- Delete: `apps/web/src/lib/agent-default-workspace.ts`

**Step 1: Remove context/workspace props from the composer**

The composer should only handle prompt, mode, attachments, model picker, and send/stop.

**Step 2: Remove workspace/context handling from chat send flow**

Stop reading workspace/context state, stop warning about missing workspace, and stop attaching `workspaceId` / `contextPaths` to optimistic messages or stream payloads.

**Step 3: Simplify chat store message/conversation types**

Remove workspace/context fields from parsed message/conversation state that the web UI no longer uses.

### Task 4: Trim web API bindings and verify

**Files:**
- Modify: `apps/web/src/lib/api.ts`
- Modify: `apps/web/src/lib/chat-stream.ts`

**Step 1: Remove unused workspace API client surface**

Delete `api.workspaces`, workspace FS types, and workspace-related request params from web-only request helpers.

**Step 2: Final verification**

Run: `pnpm --dir apps/web typecheck`
Expected: PASS

Run: `git diff --stat`
Expected: workspace-specific web surface removed with no server schema migration.
