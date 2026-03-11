# Chat Global Default Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make Chat always use the global default channel + default model, ignoring per-conversation channel binding.

**Architecture:** Centralize channel resolution in the server by passing `null` to `getResolvedChannelForUser` for Chat endpoints. Ensure conversation creation ignores `channelId` and UI does not expose channel selection.

**Tech Stack:** Hono, Drizzle ORM, Next.js App Router, Mantine UI, Zustand.

---

### Task 1: Enforce global default in Chat service

**Files:**
- Modify: `apps/server/src/services/messageService.ts`

**Step 1: Write the failing test**

```ts
import { test, expect } from "bun:test";
import { resolveChatChannelId } from "./messageService";

test("resolveChatChannelId always returns null", () => {
  expect(resolveChatChannelId("any")).toBeNull();
});
```

**Step 2: Run test to verify it fails**

Run: `cd apps/server && bun test src/services/messageService.global-default.test.ts`  
Expected: FAIL (missing export).

**Step 3: Write minimal implementation**

- Add `resolveChatChannelId()` helper that always returns `null`.
- Use it to resolve channels in both `sendMessage` and `streamMessage` so `getResolvedChannelForUser(userId, null)` is always used.

**Step 4: Run test to verify it passes**

Run: `cd apps/server && bun test src/services/messageService.global-default.test.ts`  
Expected: PASS.

**Step 5: Commit**

```
git add apps/server/src/services/messageService.ts apps/server/src/services/messageService.global-default.test.ts
git commit -m "feat: force chat to use global default channel"
```

### Task 2: Ignore channelId on conversation create

**Files:**
- Modify: `apps/server/src/services/conversationService.ts`
- Modify: `apps/web/src/components/Sidebar.tsx`

**Step 1: Write the failing test**

```ts
import { test, expect } from "bun:test";
import { normalizeConversationInput } from "./conversationService";

test("normalizeConversationInput strips channelId", () => {
  expect(normalizeConversationInput({ title: "t", channelId: "x" })).toEqual({ title: "t" });
});
```

**Step 2: Run test to verify it fails**

Run: `cd apps/server && bun test src/services/conversationService.test.ts`  
Expected: FAIL (missing helper).

**Step 3: Write minimal implementation**

- Add `normalizeConversationInput()` to strip `channelId`.
- Use it in `createConversation`.
- In `Sidebar`, keep `createConversation(title)` without `channelId`.

**Step 4: Run test to verify it passes**

Run: `cd apps/server && bun test src/services/conversationService.test.ts`  
Expected: PASS.

**Step 5: Commit**

```
git add apps/server/src/services/conversationService.ts apps/web/src/components/Sidebar.tsx apps/server/src/services/conversationService.test.ts
git commit -m "feat: ignore conversation channel binding for chat"
```

---

## Notes

- This repo is not a git repository, commit steps are placeholders.
