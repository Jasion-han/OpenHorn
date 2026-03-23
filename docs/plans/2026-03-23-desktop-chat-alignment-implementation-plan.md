# Desktop Chat Alignment Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the legacy desktop IDE-like shell with a Web-aligned two-panel chat shell while keeping Web behavior stable.

**Architecture:** Keep Web as the protected reference implementation. Build a desktop-specific chat shell, adapter, and stores inside `apps/desktop`, and only reuse low-risk presentation primitives. Remove the legacy `FileTree`, `EditorPane`, `AgentPane`, and their obsolete state once the replacement is wired.

**Tech Stack:** React 19, Tauri 2, Zustand, TypeScript, existing `ui` workspace package

---

### Task 1: Inventory desktop shell dependencies

**Files:**
- Modify: `docs/plans/2026-03-23-desktop-chat-alignment-design.md`
- Inspect: `apps/desktop/src/App.tsx`
- Inspect: `apps/desktop/src/stores/ideStore.ts`
- Inspect: `apps/desktop/src/components/FileTree.tsx`
- Inspect: `apps/desktop/src/components/EditorPane.tsx`
- Inspect: `apps/desktop/src/components/AgentPane.tsx`

**Step 1: Record every legacy desktop shell dependency**

List:
- imports from `App.tsx`
- state slices from `ideStore.ts`
- any settings or helper functions still required after shell replacement

**Step 2: Mark each dependency as keep, replace, or delete**

Update the design doc with a short appendix listing:
- keep: sidecar bootstrap, settings entry, theme listener
- replace: root shell and main chat surface
- delete: file tree, editor pane, agent pane, obsolete IDE tab state

**Step 3: Verify no code changes were made yet**

Run: `git diff --stat`
Expected: only documentation changes

**Step 4: Commit**

```bash
git add docs/plans/2026-03-23-desktop-chat-alignment-design.md docs/plans/2026-03-23-desktop-chat-alignment-implementation-plan.md
git commit -m "docs(desktop): define chat-aligned desktop migration"
```

### Task 2: Create desktop chat domain types and adapter boundary

**Files:**
- Create: `apps/desktop/src/lib/chatAdapter.ts`
- Create: `apps/desktop/src/lib/serverApi.ts`
- Create: `apps/desktop/src/types/chat.ts`
- Test: `apps/desktop/src/lib/chatAdapter.test.ts`

**Step 1: Write the failing test**

Define tests for:
- conversation list mapping
- message list mapping
- send-message request shape
- adapter contract methods existing

Run: `pnpm --filter desktop exec bun test apps/desktop/src/lib/chatAdapter.test.ts`
Expected: FAIL because files do not exist

**Step 2: Write minimal shared desktop chat types**

Create typed desktop equivalents for:
- conversation
- message
- channel
- stream event payloads

These should mirror Web semantics but remain desktop-local.

**Step 3: Implement `serverApi.ts`**

Add minimal HTTP wrapper for:
- conversations list/create/delete
- messages list/stream
- channels list
- settings read if needed by shell

Do not reuse Web API code directly in this step.

**Step 4: Implement `chatAdapter.ts`**

Provide a desktop adapter interface:
- `listConversations`
- `loadMessages`
- `sendMessage`
- `abortActiveStream`
- `listChannels`

**Step 5: Run tests and typecheck**

Run:
- `pnpm --filter desktop exec bun test apps/desktop/src/lib/chatAdapter.test.ts`
- `pnpm --filter desktop typecheck`

Expected: PASS

**Step 6: Commit**

```bash
git add apps/desktop/src/lib/chatAdapter.ts apps/desktop/src/lib/serverApi.ts apps/desktop/src/types/chat.ts apps/desktop/src/lib/chatAdapter.test.ts
git commit -m "feat(desktop): add chat adapter boundary"
```

### Task 3: Replace `ideStore` with chat-oriented desktop stores

**Files:**
- Create: `apps/desktop/src/stores/chatStore.ts`
- Create: `apps/desktop/src/stores/desktopShellStore.ts`
- Modify: `apps/desktop/src/stores/ideStore.ts`
- Test: `apps/desktop/src/stores/chatStore.test.ts`

**Step 1: Write the failing store test**

Test:
- load conversations
- select conversation
- load messages
- optimistic assistant placeholder for streaming
- composer mode toggle

Run: `pnpm --filter desktop exec bun test apps/desktop/src/stores/chatStore.test.ts`
Expected: FAIL because store does not exist

**Step 2: Create `chatStore.ts`**

Model it after Web semantics, not Web implementation.

State must include:
- conversations
- current conversation
- messages
- channels
- composer mode
- loading and streaming flags

**Step 3: Create `desktopShellStore.ts`**

Keep desktop-only shell state here:
- sidecar connection status
- sidecar error
- workspace root input
- settings open state if needed

**Step 4: Reduce `ideStore.ts`**

If any local utility remains useful, move it out.
Delete IDE-only state:
- tabs
- active editor path
- directory entries
- file open/save flow

If nothing valuable remains, delete the file instead of keeping a stub.

**Step 5: Run tests and typecheck**

Run:
- `pnpm --filter desktop exec bun test apps/desktop/src/stores/chatStore.test.ts`
- `pnpm --filter desktop typecheck`

Expected: PASS

**Step 6: Commit**

```bash
git add apps/desktop/src/stores/chatStore.ts apps/desktop/src/stores/desktopShellStore.ts apps/desktop/src/stores/ideStore.ts apps/desktop/src/stores/chatStore.test.ts
git commit -m "refactor(desktop): replace ide store with chat shell stores"
```

### Task 4: Build the new desktop shell layout

**Files:**
- Create: `apps/desktop/src/components/app/DesktopShellLayout.tsx`
- Create: `apps/desktop/src/components/app/DesktopLeftSidebar.tsx`
- Create: `apps/desktop/src/components/chat/DesktopChatArea.tsx`
- Create: `apps/desktop/src/components/chat/DesktopChatHeader.tsx`
- Create: `apps/desktop/src/components/chat/DesktopComposer.tsx`
- Modify: `apps/desktop/src/App.tsx`
- Test: `apps/desktop/src/App.test.tsx`

**Step 1: Write the failing UI smoke test**

Test that the desktop app renders:
- left sidebar
- chat area
- settings toggle

Run: `pnpm --filter desktop exec bun test apps/desktop/src/App.test.tsx`
Expected: FAIL because new components do not exist

**Step 2: Create `DesktopShellLayout.tsx`**

Mirror the Web shell proportions and styling:
- left sidebar width
- center panel layout
- mobile drawer behavior only if already needed

Do not pull in Next-specific APIs.

**Step 3: Create `DesktopLeftSidebar.tsx`**

Render:
- app header
- conversation list
- settings entry

**Step 4: Create `DesktopChatArea.tsx`, `DesktopChatHeader.tsx`, `DesktopComposer.tsx`**

Support:
- messages
- chat and agent composer mode switch
- attachments only if already supported in desktop phase one

**Step 5: Replace `App.tsx` shell**

Keep:
- theme listener
- sidecar bootstrap if still needed
- settings view route or toggle

Remove:
- `FileTree`
- `EditorPane`
- `AgentPane`

**Step 6: Run test and typecheck**

Run:
- `pnpm --filter desktop exec bun test apps/desktop/src/App.test.tsx`
- `pnpm --filter desktop typecheck`

Expected: PASS

**Step 7: Commit**

```bash
git add apps/desktop/src/App.tsx apps/desktop/src/components/app/DesktopShellLayout.tsx apps/desktop/src/components/app/DesktopLeftSidebar.tsx apps/desktop/src/components/chat/DesktopChatArea.tsx apps/desktop/src/components/chat/DesktopChatHeader.tsx apps/desktop/src/components/chat/DesktopComposer.tsx apps/desktop/src/App.test.tsx
git commit -m "feat(desktop): add web-aligned desktop chat shell"
```

### Task 5: Wire desktop streaming and inline agent mode

**Files:**
- Modify: `apps/desktop/src/lib/chatAdapter.ts`
- Modify: `apps/desktop/src/stores/chatStore.ts`
- Modify: `apps/desktop/src/components/chat/DesktopChatArea.tsx`
- Modify: `apps/desktop/src/components/chat/DesktopComposer.tsx`
- Test: `apps/desktop/src/stores/chatStore.test.ts`

**Step 1: Write failing streaming assertions**

Add tests for:
- assistant placeholder creation
- delta append during stream
- live status metadata mapping
- inline agent mode stream state updates

Run: `pnpm --filter desktop exec bun test apps/desktop/src/stores/chatStore.test.ts`
Expected: FAIL for missing stream behavior

**Step 2: Implement stream lifecycle in adapter**

Support:
- server stream open
- delta events
- done events
- error events
- abort controller

**Step 3: Implement store updates**

Update desktop messages exactly once per event category:
- append deltas
- update live metadata
- update agent run metadata
- mark streaming complete or failed

**Step 4: Reflect stream state in UI**

Desktop composer and chat area should show:
- loading state
- streaming state
- inline agent execution metadata if present

**Step 5: Run tests and typecheck**

Run:
- `pnpm --filter desktop exec bun test apps/desktop/src/stores/chatStore.test.ts`
- `pnpm --filter desktop typecheck`

Expected: PASS

**Step 6: Commit**

```bash
git add apps/desktop/src/lib/chatAdapter.ts apps/desktop/src/stores/chatStore.ts apps/desktop/src/components/chat/DesktopChatArea.tsx apps/desktop/src/components/chat/DesktopComposer.tsx apps/desktop/src/stores/chatStore.test.ts
git commit -m "feat(desktop): support inline chat and agent streaming"
```

### Task 6: Remove legacy desktop IDE workbench code

**Files:**
- Delete: `apps/desktop/src/components/FileTree.tsx`
- Delete: `apps/desktop/src/components/EditorPane.tsx`
- Delete: `apps/desktop/src/components/AgentPane.tsx`
- Modify or Delete: `apps/desktop/src/stores/ideStore.ts`
- Test: `pnpm --filter desktop typecheck`

**Step 1: Delete obsolete components**

Remove the old UI files instead of leaving dead code behind.

**Step 2: Remove unused imports and helpers**

Clean `App.tsx`, stores, and any helper files that referenced the deleted UI.

**Step 3: Search for leftovers**

Run:

```bash
rg -n "FileTree|EditorPane|AgentPane|ideStore|openFile|loadDir|saveActiveFile" apps/desktop/src
```

Expected: only valid remaining references, or no matches

**Step 4: Run typecheck and desktop build smoke test**

Run:
- `pnpm --filter desktop typecheck`
- `pnpm --filter desktop build:ui`

Expected: PASS

**Step 5: Commit**

```bash
git add apps/desktop/src
git commit -m "refactor(desktop): remove legacy ide workbench"
```

### Task 7: Verify Web remains unchanged

**Files:**
- Inspect only: `apps/web/src/components/app/AppShellLayout.tsx`
- Inspect only: `apps/web/src/components/app/LeftSidebar.tsx`
- Inspect only: `apps/web/src/components/ChatArea.tsx`

**Step 1: Confirm no unintended Web edits**

Run:

```bash
git diff -- apps/web
```

Expected: no Web diffs unless intentionally approved later

**Step 2: Run Web typecheck**

Run:

```bash
pnpm --filter web typecheck
```

Expected: PASS

**Step 3: Manual regression check**

Verify:
- Web left sidebar still opens conversations
- Web middle chat area still streams chat and agent replies
- Settings route still works

**Step 4: Commit final cleanup if needed**

```bash
git add apps/desktop apps/web
git commit -m "chore(desktop): verify web-safe desktop alignment"
```
