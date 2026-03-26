# Desktop Agent Mode Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Rework the desktop `Agent` flow so new agent turns always use task-backed execution with a unified, minimal execution surface that supports Claude Agent SDK capabilities including bash, tools, MCP, and skills.

**Architecture:** The desktop composer will stop treating `Agent` as a variant of the legacy message stream and instead create and drive `/agent/tasks` as the primary execution model. The UI will project task detail and streamed task events into a single agent response block with inline approval and optional expanded details. Legacy `message.agentRun.steps` rendering stays only as a compatibility fallback for older data.

**Tech Stack:** React 19, Zustand, Tauri desktop shell, TypeScript, Hono server routes, Claude Agent SDK task execution, SSE streams

---

### Task 1: Add desktop task-creation API support

**Files:**
- Modify: `apps/desktop/src/lib/serverApi.ts`
- Test: `apps/desktop/src/lib/chatAdapter.test.ts`

**Step 1: Write the failing test**

Add a test case that expects the desktop server API layer to expose a task creation method that POSTs to `/agent/tasks` with `conversationId`, `channelId`, `modelId`, `title`, `goal`, and attachments.

**Step 2: Run test to verify it fails**

Run: `pnpm --filter desktop exec vitest run apps/desktop/src/lib/chatAdapter.test.ts`
Expected: FAIL because `agentTasks.create` does not exist.

**Step 3: Write minimal implementation**

Add `agentTasks.create` to the desktop server API contract and implementation in `apps/desktop/src/lib/serverApi.ts`.

**Step 4: Run test to verify it passes**

Run: `pnpm --filter desktop exec vitest run apps/desktop/src/lib/chatAdapter.test.ts`
Expected: PASS for the new API contract test.

**Step 5: Commit**

```bash
git add apps/desktop/src/lib/serverApi.ts apps/desktop/src/lib/chatAdapter.test.ts
git commit -m "feat(desktop): add agent task creation api"
```

### Task 2: Extend desktop chat/task types for unified task-backed agent turns

**Files:**
- Modify: `apps/desktop/src/types/chat.ts`
- Modify: `apps/desktop/src/lib/chatAdapter.ts`
- Test: `apps/desktop/src/lib/chatAdapter.test.ts`

**Step 1: Write the failing test**

Add a test that maps a task-backed assistant message into a desktop message shape that includes enough information to render a unified task surface from `taskId`, reduced task state, and approval metadata.

**Step 2: Run test to verify it fails**

Run: `pnpm --filter desktop exec vitest run apps/desktop/src/lib/chatAdapter.test.ts`
Expected: FAIL because the mapped message shape is incomplete for task-backed agent mode.

**Step 3: Write minimal implementation**

Update desktop types and mapping helpers so the desktop layer can consistently interpret task-backed agent payloads.

**Step 4: Run test to verify it passes**

Run: `pnpm --filter desktop exec vitest run apps/desktop/src/lib/chatAdapter.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add apps/desktop/src/types/chat.ts apps/desktop/src/lib/chatAdapter.ts apps/desktop/src/lib/chatAdapter.test.ts
git commit -m "feat(desktop): extend task-backed agent message types"
```

### Task 3: Route desktop Agent composer sends through task creation

**Files:**
- Modify: `apps/desktop/src/components/chat/DesktopChatArea.tsx`
- Modify: `apps/desktop/src/stores/chatStore.ts`
- Test: `apps/desktop/src/stores/chatStore.test.ts`

**Step 1: Write the failing test**

Add a store/component-level test that verifies an `Agent` send creates a task-backed placeholder flow rather than directly using the legacy message-stream-only path.

**Step 2: Run test to verify it fails**

Run: `pnpm --filter desktop exec vitest run apps/desktop/src/stores/chatStore.test.ts`
Expected: FAIL because `Agent` sends still use the old path.

**Step 3: Write minimal implementation**

Change the desktop send flow so:
- `Chat` keeps using `/messages/stream`
- `Agent` creates a task first
- the UI inserts one assistant placeholder linked to `taskId`
- planning or execution begins according to task defaults

**Step 4: Run test to verify it passes**

Run: `pnpm --filter desktop exec vitest run apps/desktop/src/stores/chatStore.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add apps/desktop/src/components/chat/DesktopChatArea.tsx apps/desktop/src/stores/chatStore.ts apps/desktop/src/stores/chatStore.test.ts
git commit -m "feat(desktop): route agent composer sends through tasks"
```

### Task 4: Replace stacked task cards with one unified desktop agent block

**Files:**
- Modify: `apps/desktop/src/components/chat/DesktopAgentTaskCard.tsx`
- Modify: `apps/desktop/src/components/chat/DesktopChatArea.tsx`
- Test: `apps/desktop/src/components/chat/DesktopAgentTaskCard.test.tsx` (create if missing)

**Step 1: Write the failing test**

Add a rendering test that expects:
- one unified agent container
- visible status line
- visible current action line
- collapsed process summary by default
- final body shown without nested card stacks

**Step 2: Run test to verify it fails**

Run: `pnpm --filter desktop exec vitest run apps/desktop/src/components/chat/DesktopAgentTaskCard.test.tsx`
Expected: FAIL because the current component still renders multiple sections/cards.

**Step 3: Write minimal implementation**

Refactor `DesktopAgentTaskCard` to:
- flatten the visual hierarchy
- render one compact process summary
- keep expand/collapse detail sections secondary
- preserve task controls without card stacking

**Step 4: Run test to verify it passes**

Run: `pnpm --filter desktop exec vitest run apps/desktop/src/components/chat/DesktopAgentTaskCard.test.tsx`
Expected: PASS.

**Step 5: Commit**

```bash
git add apps/desktop/src/components/chat/DesktopAgentTaskCard.tsx apps/desktop/src/components/chat/DesktopChatArea.tsx apps/desktop/src/components/chat/DesktopAgentTaskCard.test.tsx
git commit -m "feat(desktop): unify agent execution block layout"
```

### Task 5: Project task detail into reduced desktop agent states

**Files:**
- Modify: `apps/desktop/src/components/chat/DesktopAgentTaskCard.tsx`
- Test: `apps/desktop/src/components/chat/DesktopAgentTaskCard.test.tsx`

**Step 1: Write the failing test**

Add tests for reduced desktop states:
- `draft`
- `planning`
- `acting`
- `awaiting_approval`
- `resolving`
- terminal states

**Step 2: Run test to verify it fails**

Run: `pnpm --filter desktop exec vitest run apps/desktop/src/components/chat/DesktopAgentTaskCard.test.tsx`
Expected: FAIL because the component still mirrors backend-specific states too directly.

**Step 3: Write minimal implementation**

Add a projection layer that converts task detail and stream events into the reduced desktop UI state model.

**Step 4: Run test to verify it passes**

Run: `pnpm --filter desktop exec vitest run apps/desktop/src/components/chat/DesktopAgentTaskCard.test.tsx`
Expected: PASS.

**Step 5: Commit**

```bash
git add apps/desktop/src/components/chat/DesktopAgentTaskCard.tsx apps/desktop/src/components/chat/DesktopAgentTaskCard.test.tsx
git commit -m "feat(desktop): add reduced agent ui state projection"
```

### Task 6: Humanize Claude Agent SDK event categories

**Files:**
- Modify: `apps/desktop/src/components/chat/DesktopAgentTaskCard.tsx`
- Modify: `apps/desktop/src/lib/agentTaskStream.ts`
- Test: `apps/desktop/src/components/chat/DesktopAgentTaskCard.test.tsx`

**Step 1: Write the failing test**

Add tests that verify bash/tool/MCP/skill events are summarized into user-facing action lines such as:
- `Running command`
- `Using tool`
- `Using MCP`
- `Using workflow capability`

**Step 2: Run test to verify it fails**

Run: `pnpm --filter desktop exec vitest run apps/desktop/src/components/chat/DesktopAgentTaskCard.test.tsx`
Expected: FAIL because current event handling is too tool-name-specific and card-oriented.

**Step 3: Write minimal implementation**

Refactor event summarization so the desktop agent block uses a unified event model with secondary expanded details.

**Step 4: Run test to verify it passes**

Run: `pnpm --filter desktop exec vitest run apps/desktop/src/components/chat/DesktopAgentTaskCard.test.tsx`
Expected: PASS.

**Step 5: Commit**

```bash
git add apps/desktop/src/components/chat/DesktopAgentTaskCard.tsx apps/desktop/src/lib/agentTaskStream.ts apps/desktop/src/components/chat/DesktopAgentTaskCard.test.tsx
git commit -m "feat(desktop): humanize sdk event rendering"
```

### Task 7: Add inline approval UX for plan and dangerous actions

**Files:**
- Modify: `apps/desktop/src/components/chat/DesktopAgentTaskCard.tsx`
- Test: `apps/desktop/src/components/chat/DesktopAgentTaskCard.test.tsx`

**Step 1: Write the failing test**

Add tests that expect approval to render inline inside the unified agent block with:
- concise reason text
- `Approve`
- `Reject`
- optional detail toggle

**Step 2: Run test to verify it fails**

Run: `pnpm --filter desktop exec vitest run apps/desktop/src/components/chat/DesktopAgentTaskCard.test.tsx`
Expected: FAIL because the current approval UX is not yet aligned to the simplified interaction model.

**Step 3: Write minimal implementation**

Refactor approval rendering so it becomes the only strong interrupt state and remove extra structural noise around it.

**Step 4: Run test to verify it passes**

Run: `pnpm --filter desktop exec vitest run apps/desktop/src/components/chat/DesktopAgentTaskCard.test.tsx`
Expected: PASS.

**Step 5: Commit**

```bash
git add apps/desktop/src/components/chat/DesktopAgentTaskCard.tsx apps/desktop/src/components/chat/DesktopAgentTaskCard.test.tsx
git commit -m "feat(desktop): simplify inline approval flow"
```

### Task 8: Expose agent behavior defaults in settings

**Files:**
- Modify: `apps/desktop/src/components/settings/AgentSettings.tsx`
- Modify: `apps/desktop/src/lib/serverApi.ts`
- Test: `apps/desktop/src/components/settings/AgentSettings.test.tsx` (create if missing)

**Step 1: Write the failing test**

Add a test that expects the Agent settings page to expose defaults for:
- execution mode
- reasoning depth
- plan approval
- auto-start

**Step 2: Run test to verify it fails**

Run: `pnpm --filter desktop exec vitest run apps/desktop/src/components/settings/AgentSettings.test.tsx`
Expected: FAIL because current settings only cover provider/search/MCP framing.

**Step 3: Write minimal implementation**

Add the settings UI and persistence plumbing required for the new task defaults.

**Step 4: Run test to verify it passes**

Run: `pnpm --filter desktop exec vitest run apps/desktop/src/components/settings/AgentSettings.test.tsx`
Expected: PASS.

**Step 5: Commit**

```bash
git add apps/desktop/src/components/settings/AgentSettings.tsx apps/desktop/src/lib/serverApi.ts apps/desktop/src/components/settings/AgentSettings.test.tsx
git commit -m "feat(desktop): add agent behavior defaults"
```

### Task 9: Preserve compatibility for legacy agent-run messages

**Files:**
- Modify: `apps/desktop/src/components/chat/DesktopChatArea.tsx`
- Modify: `apps/desktop/src/components/chat/DesktopAgentTaskCard.tsx`
- Test: `apps/desktop/src/components/chat/DesktopAgentTaskCard.test.tsx`

**Step 1: Write the failing test**

Add tests proving that older messages with only `agentRun.steps` still render cleanly, but do not block the new task-backed flow.

**Step 2: Run test to verify it fails**

Run: `pnpm --filter desktop exec vitest run apps/desktop/src/components/chat/DesktopAgentTaskCard.test.tsx`
Expected: FAIL if the new task-backed assumptions break older message rendering.

**Step 3: Write minimal implementation**

Keep a fallback renderer for legacy data and ensure the default composer path no longer depends on it.

**Step 4: Run test to verify it passes**

Run: `pnpm --filter desktop exec vitest run apps/desktop/src/components/chat/DesktopAgentTaskCard.test.tsx`
Expected: PASS.

**Step 5: Commit**

```bash
git add apps/desktop/src/components/chat/DesktopChatArea.tsx apps/desktop/src/components/chat/DesktopAgentTaskCard.tsx apps/desktop/src/components/chat/DesktopAgentTaskCard.test.tsx
git commit -m "feat(desktop): keep legacy agent rendering as fallback"
```

### Task 10: Verify end-to-end behavior with desktop dev stack

**Files:**
- Modify: `docs/plans/2026-03-26-desktop-agent-mode-design.md` if validation notes are needed
- Test: manual E2E using desktop dev server and Playwright

**Step 1: Run targeted automated tests**

Run:
- `pnpm --filter desktop exec vitest run apps/desktop/src/lib/chatAdapter.test.ts`
- `pnpm --filter desktop exec vitest run apps/desktop/src/stores/chatStore.test.ts`
- `pnpm --filter desktop exec vitest run apps/desktop/src/components/chat/DesktopAgentTaskCard.test.tsx`
- `pnpm --filter desktop exec vitest run apps/desktop/src/components/settings/AgentSettings.test.tsx`

Expected: PASS.

**Step 2: Run desktop typecheck**

Run: `pnpm --filter desktop typecheck`
Expected: PASS.

**Step 3: Run manual desktop verification**

Verify:
- new `Agent` turn creates task-backed flow
- compact task remains visually minimal
- approval renders inline
- bash/tool/MCP/skill events show unified action lines
- final answer remains dominant after completion

**Step 4: Record validation notes**

If any UX adjustments are needed, append concise validation notes to the design doc.

**Step 5: Commit**

```bash
git add docs/plans/2026-03-26-desktop-agent-mode-design.md
git commit -m "docs: record desktop agent mode validation notes"
```
