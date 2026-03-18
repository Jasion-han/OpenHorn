# Agent Recent Context Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add bounded recent conversation context to `Agent` mode so same-thread follow-up questions keep references to earlier turns.

**Architecture:** `messageService.ts` will collect the latest 8 text messages from the current conversation for Agent runs and pass them to `agentService.ts`. `agentService.ts` will serialize those messages into a compact prompt prefix before the current task, without replaying tool traces or historical attachments.

**Tech Stack:** Bun, TypeScript, Drizzle, Claude Agent SDK

---

### Task 1: Add failing Agent-context coverage

**Files:**
- Modify: `apps/server/src/services/messageService.live.test.ts`

**Step 1: Write the failing test**

Add a test where:
- the conversation already contains a prior `user` + `assistant` pair,
- a second Agent turn asks an ambiguous follow-up,
- the mocked `runAgentWithConfig(...)` receives recent conversation context with both prior messages.

**Step 2: Run test to verify it fails**

Run: `pnpm --filter server exec bun test src/services/messageService.live.test.ts`
Expected: FAIL because Agent runs do not yet receive recent context.

**Step 3: Commit**

Skip until implementation is done.

### Task 2: Build bounded recent history in message service

**Files:**
- Modify: `apps/server/src/services/messageService.ts`

**Step 1: Add a small helper**

Create a helper that:
- accepts ordered conversation messages,
- slices to the latest 8 messages,
- keeps only non-empty `user` / `assistant` text messages,
- returns lightweight `{ role, content }` items.

**Step 2: Wire send/edit/regenerate Agent flows**

Use that helper in:
- `streamMessage(...)` Agent branch
- `editUserMessage(...)` Agent branch
- `regenerateMessage(...)` Agent branch

Pass the resulting history into `runAgentWithConfig(...)`.

### Task 3: Inject history into the Agent prompt

**Files:**
- Modify: `apps/server/src/services/agentService.ts`

**Step 1: Extend runtime config**

Add an optional `conversationHistory` field with lightweight `{ role, content }[]`.

**Step 2: Serialize into prompt**

Build:
- `Recent conversation context:`
- `User: ...`
- `Assistant: ...`
- blank line
- `Task: ...`

Do not include the current turn twice.

### Task 4: Verify and commit

**Files:**
- Modify: `apps/server/src/services/messageService.live.test.ts`
- Modify: `apps/server/src/services/messageService.ts`
- Modify: `apps/server/src/services/agentService.ts`

**Step 1: Run targeted tests**

Run: `pnpm --filter server exec bun test src/services/messageService.live.test.ts`
Expected: PASS

**Step 2: Run type checks**

Run: `pnpm --filter server exec tsc --noEmit`
Run: `pnpm --filter web exec tsc --noEmit`
Expected: PASS

**Step 3: Commit**

```bash
git add docs/plans/2026-03-18-agent-recent-context-design.md docs/plans/2026-03-18-agent-recent-context-implementation-plan.md apps/server/src/services/messageService.live.test.ts apps/server/src/services/messageService.ts apps/server/src/services/agentService.ts
git commit -m "Add recent conversation context to agent mode"
```
