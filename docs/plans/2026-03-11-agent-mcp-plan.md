# Agent MCP Integration Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Inject enabled MCP server configs into Claude Agent SDK calls.

**Architecture:** Load enabled MCP servers from DB, parse configs, and pass to `runClaudeAgentSdk` as `mcpServers`.

**Tech Stack:** Hono, Drizzle ORM, Claude Agent SDK.

---

### Task 1: Add MCP loader utility

**Files:**
- Create: `apps/server/src/services/mcpLoader.ts`
- Modify: `apps/server/src/services/agentService.ts`
- Modify: `apps/server/src/services/agentSdk.ts`

**Step 1: Write the failing test**

```ts
import { test, expect } from "bun:test";
import { buildMcpServerMap } from "./mcpLoader";

test("buildMcpServerMap skips invalid JSON", () => {
  const servers = [
    { id: "1", name: "bad", config: "{", isEnabled: true },
    { id: "2", name: "good", config: "{\"type\":\"stdio\"}", isEnabled: true },
  ];
  const result = buildMcpServerMap(servers as never);
  expect(Object.keys(result).length).toBe(1);
});
```

**Step 2: Run test to verify it fails**

Run: `cd apps/server && bun test src/services/mcpLoader.test.ts`  
Expected: FAIL (module not found).

**Step 3: Write minimal implementation**

- Load enabled servers from DB
- Parse JSON; skip invalid
- Return map keyed by server name or id

**Step 4: Run test to verify it passes**

Run: `cd apps/server && bun test src/services/mcpLoader.test.ts`  
Expected: PASS.

**Step 5: Commit**

```
git add apps/server/src/services/mcpLoader.ts apps/server/src/services/mcpLoader.test.ts apps/server/src/services/agentSdk.ts apps/server/src/services/agentService.ts
git commit -m "feat: inject mcp servers into agent sdk"
```

---

## Notes

- Repo lacks git; commits are placeholders.
