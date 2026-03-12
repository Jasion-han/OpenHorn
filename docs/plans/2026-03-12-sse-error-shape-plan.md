# SSE Error Shape Compatibility Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Ensure SSE `error` events work across Chat and Agent by emitting both `message` and `content` from the server, and improve Agent non-OK error visibility.

**Architecture:** Normalize the event shape at the source (`createSseStream`) so all SSE consumers benefit. Keep clients strict: show the real error, do not auto-switch/fallback.

**Tech Stack:** Bun server (Hono), Next.js web (React), SSE streams.

---

### Task 1: Update Server SSE Error Event Shape

**Files:**
- Modify: `apps/server/src/utils/sse.ts`

**Step 1: Emit both `message` and `content`**

- In the `catch` block of `createSseStream`, replace the current send payload with:
  - `type: 'error'`
  - `message: <string>`
  - `content: <string>`

**Step 2: Run a quick typecheck**

Run: `pnpm --filter server typecheck`
Expected: No new TypeScript errors (existing repo quirks aside).

**Step 3: Commit**

```bash
git add apps/server/src/utils/sse.ts
git commit -m "fix(server): include content on sse error events"
```

---

### Task 2: Improve Agent non-OK response error text

**Files:**
- Modify: `apps/web/src/app/(app)/agent/page.tsx`

**Step 1: When `response.ok` is false, surface body text**

- Replace `throw new Error('Failed to run agent')` with:
  - `const text = await response.text().catch(() => '')`
  - `throw new Error(text || 'Failed to run agent')`

**Step 2: Run web typecheck**

Run: `pnpm --filter web typecheck`
Expected: PASS

**Step 3: Commit**

```bash
git add apps/web/src/app/(app)/agent/page.tsx
git commit -m "fix(web): show agent run error body"
```

---

### Task 3: Manual QA

Run: `pnpm dev`

- Trigger a server-side error during Agent run (e.g. missing default model or bad API key):
  - Verify Agent timeline shows an error card with text (not blank).
- Ensure Chat streaming still renders errors normally.

