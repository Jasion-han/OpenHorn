# Agent SDK Integration Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the current Agent run logic with Claude Agent SDK while preserving the existing SSE event format.

**Architecture:** `runAgent` calls SDK, converts events to `AgentEvent`, and uses existing SSE streaming. Workspace `cwd` and global default channel/model remain required inputs.

**Tech Stack:** Hono, Drizzle ORM, Claude Agent SDK.

---

### Task 1: Add SDK wrapper and event conversion

**Files:**
- Modify: `apps/server/src/services/agentService.ts`
- Create: `apps/server/src/services/agentSdk.ts`

**Step 1: Write the failing test**

```ts
import { test, expect } from "bun:test";
import { convertSdkEvent } from "./agentSdk";

test("convertSdkEvent maps text", () => {
  const result = convertSdkEvent({ type: "content", content: "hi" });
  expect(result?.type).toBe("text");
});
```

**Step 2: Run test to verify it fails**

Run: `cd apps/server && bun test src/services/agentSdk.test.ts`  
Expected: FAIL (module not found).

**Step 3: Write minimal implementation**

- Implement `agentSdk.ts` that:
  - runs SDK query
  - yields converted `AgentEvent`
- Implement `convertSdkEvent` with minimal mapping:
  - content/text → `text`
  - tool start → `tool_start`
  - tool result → `tool_result`

**Step 4: Run test to verify it passes**

Run: `cd apps/server && bun test src/services/agentSdk.test.ts`  
Expected: PASS.

**Step 5: Commit**

```
git add apps/server/src/services/agentSdk.ts apps/server/src/services/agentSdk.test.ts apps/server/src/services/agentService.ts
git commit -m "feat: integrate claude agent sdk"
```

### Task 2: Wire runAgent to SDK

**Files:**
- Modify: `apps/server/src/services/agentService.ts`

**Step 1: Manual verification**

- Start server, run agent, verify streaming events produce content.

---

## Notes

- Repo lacks git; commit steps are placeholders.
