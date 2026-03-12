# Chat UI Default Model Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Show global default provider+model near Chat input and guide user to settings when missing.

**Architecture:** Add a client helper to resolve the global default channel + model from `api.channels.list()` and reuse it in Chat UI. No writes from Chat.

**Tech Stack:** Next.js App Router, Mantine UI, Zustand.

---

### Task 1: Add default channel resolver helper

**Files:**
- Create: `apps/web/src/lib/default-channel.ts`

**Step 1: Write the failing test**

```ts
import { getGlobalDefaultChannel } from "./default-channel";

const result = getGlobalDefaultChannel([
  { id: "1", provider: "openai", isDefault: true, models: [{ modelId: "gpt-4o", isDefault: true, enabled: true }] },
]);
if (!result || result.modelId !== "gpt-4o") throw new Error("failed");
```

**Step 2: Run test to verify it fails**

Run: `node apps/web/src/lib/default-channel.test.ts`  
Expected: FAIL (module not found).

**Step 3: Write minimal implementation**

- Implement `getGlobalDefaultChannel(channels)`
- Return `{ channel, model } | null`
- Ensure model is enabled

**Step 4: Run test to verify it passes**

Run: `node apps/web/src/lib/default-channel.test.ts`  
Expected: PASS.

**Step 5: Commit**

```
git add apps/web/src/lib/default-channel.ts apps/web/src/lib/default-channel.test.ts
git commit -m "feat: add default channel resolver"
```

### Task 2: Update Chat UI to show provider/model and empty-state banner

**Files:**
- Modify: `apps/web/src/components/ChatArea.tsx`

**Step 1: Write the failing test**

```ts
import { getGlobalDefaultChannel } from "../lib/default-channel";
if (!getGlobalDefaultChannel) throw new Error("missing");
```

**Step 2: Run test to verify it fails**

Run: `node apps/web/src/lib/chat-default.check.ts`  
Expected: FAIL initially.

**Step 3: Write minimal implementation**

- Load channels (reuse existing store or fetch once in ChatArea)
- Resolve default via helper
- If missing: show banner + “去设置” button and disable send
- If present: display `Provider · Model` near input

**Step 4: Manual verification**

- With no default channel: banner shows, send disabled
- With default channel+model: banner hidden, label visible

**Step 5: Commit**

```
git add apps/web/src/components/ChatArea.tsx
git commit -m "feat: show default provider/model in chat input"
```

---

## Notes

- Repo lacks git; commits are placeholders.
