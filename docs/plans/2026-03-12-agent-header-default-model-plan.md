# Agent Header Default Model Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Show effective global default `Provider · Model` in the Agent page header and provide a guided fix path; guard Agent runs when defaults are missing (no auto fallback).

**Architecture:** Agent page fetches channels at bootstrap and uses `getGlobalDefaultChannel()` as the single resolver (same strict semantics used across the app). UI is display-only; Settings remains the place for mutations.

**Tech Stack:** Next.js (React), Mantine UI, existing REST API.

---

### Task 1: Fetch Channels In Agent Bootstrap

**Files:**
- Modify: `apps/web/src/app/(app)/agent/page.tsx`

**Step 1: Extend bootstrap Promise.all**

- Add `api.channels.list()` call.
- Store channels in local state on the Agent page (do not add new global store).

**Step 2: Run typecheck**

Run: `pnpm --filter web typecheck`
Expected: PASS

---

### Task 2: Display Default Model In Agent Header

**Files:**
- Modify: `apps/web/src/app/(app)/agent/page.tsx`

**Step 1: Compute default**

- Use `getGlobalDefaultChannel(channels)` in a `useMemo`.

**Step 2: Render header UI**

- If default exists: show `继承默认` badge + a small button with `${provider} · ${modelId}` linking to Settings -> Channels focus default.
- If missing: show a `去设置默认模型` button (same link).
- Ensure truncation so labels don't blow out layout on small screens.

**Step 3: Run typecheck**

Run: `pnpm --filter web typecheck`
Expected: PASS

---

### Task 3: Guard Agent Run When Default Missing

**Files:**
- Modify: `apps/web/src/app/(app)/agent/page.tsx`

**Step 1: Add pre-check in handleRun**

- If no default channel/model, show a clear error notification and return.
- Do not try other models or auto-switch providers.

**Step 2: Run typecheck**

Run: `pnpm --filter web typecheck`
Expected: PASS

---

### Task 4: Manual QA

**Step 1: Start web**

Run: `pnpm --filter web dev`
Expected: `http://localhost:3001`

**Step 2: Verify**

- With a valid default channel+model:
  - Agent header shows `继承默认` + `${provider} · ${model}`
  - Click navigates to Channels settings.
- With missing/invalid default:
  - Agent header shows "去设置默认模型"
  - Clicking Run shows the error and does not start streaming.

