# Web Agent Workbench V1 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a task-first web Agent workbench that separates planning from execution, introduces persisted approvals and artifacts, and replaces the current message-centric Agent page with a durable task UI.

**Architecture:** Keep the current chat/session Agent flow intact as a compatibility path while introducing a new `/agent/tasks` model in the server and a dedicated workbench UI in the web app. The new path will persist `task`, `run`, `plan_step`, `approval`, and `artifact` records, stream typed task events to the frontend, and let the web UI render task state, plans, execution progress, approvals, and final results separately.

**Tech Stack:** Bun, Hono, Drizzle ORM, Next.js 15, React 19, Zustand, TypeScript, Claude Agent SDK

---

### Task 1: Add database schema for task-first Agent entities

**Files:**
- Modify: `packages/db/src/schema/index.ts`
- Modify: `apps/server/src/db/bootstrap.ts`
- Test: `apps/server/src/db/schema-import.test.ts`

**Step 1: Write the failing schema coverage**

Add or update schema coverage so the test imports the new Agent task tables and verifies the schema compiles after the new entities are introduced.

**Step 2: Run test to verify it fails**

Run: `pnpm --filter server exec bun test src/db/schema-import.test.ts`
Expected: FAIL because the new task-first tables are not defined yet.

**Step 3: Write minimal schema**

Add initial Drizzle tables for:
- `agentTasks`
- `agentRuns`
- `agentPlanSteps`
- `agentApprovalRequests`
- `agentArtifacts`

Start with only the fields required by the approved design:
- ids, ownership, task status, run phase/status, plan step status, approval status/type, artifact type/content, timestamps

Mirror the same tables in bootstrap SQL so local SQLite bootstrapping still works.

**Step 4: Run schema test**

Run: `pnpm --filter server exec bun test src/db/schema-import.test.ts`
Expected: PASS

### Task 2: Add server types and service layer for Agent tasks

**Files:**
- Create: `apps/server/src/services/agentTaskService.ts`
- Modify: `apps/server/src/services/agentService.ts`
- Modify: `apps/server/src/services/unifiedConversationService.ts`

**Step 1: Write the failing service test**

Add a focused test file for the new task service that expects:
- task creation
- task detail loading
- status transitions
- plan-step persistence

**Step 2: Run test to verify it fails**

Run: `pnpm --filter server exec bun test src/services/agentTaskService.test.ts`
Expected: FAIL because the service does not exist yet.

**Step 3: Implement the new service**

Create service functions for:
- create task
- list tasks
- get task detail
- create run
- persist plan steps
- persist execution events
- create approvals
- create artifacts
- update task/run status

Keep this service separate from the existing session-based Agent flow to avoid breaking the current UI.

**Step 4: Run task-service test**

Run: `pnpm --filter server exec bun test src/services/agentTaskService.test.ts`
Expected: PASS

### Task 3: Add task-oriented Agent routes

**Files:**
- Modify: `apps/server/src/routes/agent.ts`
- Test: `apps/server/src/routes/agent.run.test.ts`
- Create: `apps/server/src/routes/agent.tasks.test.ts`

**Step 1: Write failing route coverage**

Add route tests for:
- `POST /agent/tasks`
- `GET /agent/tasks`
- `GET /agent/tasks/:id`
- `POST /agent/tasks/:id/plan`
- `POST /agent/tasks/:id/execute`
- `POST /agent/approvals/:id/respond`

At minimum verify status codes, required payload validation, and task lifecycle changes.

**Step 2: Run tests to verify they fail**

Run: `pnpm --filter server exec bun test src/routes/agent.tasks.test.ts`
Expected: FAIL because the task endpoints do not exist yet.

**Step 3: Implement minimal routes**

Add task-oriented endpoints alongside the existing session routes.

For v1:
- `plan` may produce a mocked or first-pass structured plan from the Agent runtime
- `execute` should require an approved plan
- approvals must mutate persisted approval status

Do not remove existing session routes.

**Step 4: Run route tests**

Run: `pnpm --filter server exec bun test src/routes/agent.tasks.test.ts`
Expected: PASS

### Task 4: Split planning from execution in the Agent runtime

**Files:**
- Modify: `apps/server/src/services/agentService.ts`
- Modify: `apps/server/src/services/agentSdk.ts`
- Modify: `apps/server/src/services/messageService.ts`
- Test: `apps/server/src/services/agentSdk.test.ts`

**Step 1: Write failing runtime coverage**

Add tests that expect:
- planning mode returns structured plan output without entering execution
- execution mode consumes approved plan input
- task streams emit typed task events rather than only text deltas

**Step 2: Run tests to verify they fail**

Run: `pnpm --filter server exec bun test src/services/agentSdk.test.ts`
Expected: FAIL because the runtime has no planning/execution split.

**Step 3: Implement the split**

Extend the Agent runtime so it can:
- run in `planning` mode
- run in `execution` mode
- emit typed events for status, plan steps, approvals, execution updates, and artifacts

Keep the current session/chat runtime behavior intact while wiring the new task path to the new event model.

**Step 4: Run runtime tests**

Run: `pnpm --filter server exec bun test src/services/agentSdk.test.ts`
Expected: PASS

### Task 5: Persist approvals as real task state

**Files:**
- Modify: `apps/server/src/services/agentTaskService.ts`
- Modify: `apps/server/src/routes/agent.ts`
- Modify: `apps/server/src/services/mcpLoader.ts`
- Test: `apps/server/src/routes/agent.tasks.test.ts`

**Step 1: Add failing approval coverage**

Add tests that expect:
- plan generation creates a pending `plan_approval`
- task status moves to `awaiting_approval`
- responding to an approval updates the approval record and unblocks execution

**Step 2: Run tests to verify they fail**

Run: `pnpm --filter server exec bun test src/routes/agent.tasks.test.ts`
Expected: FAIL because approvals are not persisted task state yet.

**Step 3: Implement persisted approvals**

Add approval persistence and response handling so refresh/reload does not lose approval state.

If tool-level approval hooks are not fully available in web runtime yet, land plan approval first and leave explicit TODO seams for tool approval hooks.

**Step 4: Run approval tests**

Run: `pnpm --filter server exec bun test src/routes/agent.tasks.test.ts`
Expected: PASS

### Task 6: Add artifact persistence and final-result separation

**Files:**
- Modify: `apps/server/src/services/agentTaskService.ts`
- Modify: `apps/server/src/routes/agent.ts`
- Test: `apps/server/src/services/agentTaskService.test.ts`

**Step 1: Write failing artifact coverage**

Add tests that expect a completed run to store:
- final summary artifact
- optional structured result artifact
- final result separate from raw execution events

**Step 2: Run tests to verify they fail**

Run: `pnpm --filter server exec bun test src/services/agentTaskService.test.ts`
Expected: FAIL because artifacts are not stored yet.

**Step 3: Implement minimal artifact storage**

Persist at least:
- one `final_result` artifact
- one `execution_summary` artifact when the run completes

Expose them through task detail and dedicated artifact-list endpoints.

**Step 4: Run artifact tests**

Run: `pnpm --filter server exec bun test src/services/agentTaskService.test.ts`
Expected: PASS

### Task 7: Add typed task API client support in the web app

**Files:**
- Modify: `apps/web/src/lib/api.ts`
- Modify: `apps/web/src/lib/chat-stream.ts`
- Create: `apps/web/src/lib/agent-task-stream.ts`

**Step 1: Write failing type coverage**

Add or update type-check-sensitive code so the web app expects:
- task list/detail payloads
- approval response payloads
- artifact payloads
- typed task stream events

**Step 2: Run type check to verify it fails**

Run: `pnpm --filter web exec tsc --noEmit`
Expected: FAIL because the new client types and helpers are missing.

**Step 3: Implement API helpers**

Add web client support for:
- task CRUD
- plan
- execute
- retry
- continue
- approval response
- task detail loading
- artifact loading
- typed task SSE stream helper

Leave the existing chat stream helper untouched for chat mode.

**Step 4: Run type check**

Run: `pnpm --filter web exec tsc --noEmit`
Expected: PASS

### Task 8: Add a dedicated Agent workbench store

**Files:**
- Create: `apps/web/src/stores/agentTaskStore.ts`
- Modify: `apps/web/src/stores/agentStore.ts`
- Modify: `apps/web/src/stores/chatStore.ts`

**Step 1: Write the store shape**

Define state for:
- tasks
- selected task
- current run
- plan steps
- pending approvals
- execution events
- artifacts
- loading and streaming flags

**Step 2: Wire initial actions**

Add actions for:
- load tasks
- load task detail
- create task
- request plan
- approve plan
- execute task
- cancel task
- retry task
- continue task
- respond to approval
- stream task updates

**Step 3: Run type check**

Run: `pnpm --filter web exec tsc --noEmit`
Expected: PASS

### Task 9: Replace the `/agent` page with the new workbench shell

**Files:**
- Modify: `apps/web/src/app/(app)/agent/page.tsx`
- Create: `apps/web/src/components/agent/AgentWorkbench.tsx`
- Create: `apps/web/src/components/agent/AgentTaskList.tsx`
- Create: `apps/web/src/components/agent/AgentTaskHeader.tsx`
- Create: `apps/web/src/components/agent/AgentGoalPanel.tsx`

**Step 1: Build the layout shell**

Create the three-column layout:
- left: task list
- center: task workspace
- right: tabs for artifacts, tools, sources, context

**Step 2: Connect real store data**

Load tasks from the new store and show the selected task detail in the center panel.

**Step 3: Preserve existing navigation**

Keep `/agent` as the entry point, but stop rendering the generic `ChatArea` there.

**Step 4: Run type check**

Run: `pnpm --filter web exec tsc --noEmit`
Expected: PASS

### Task 10: Add plan, execution, approval, and result panels

**Files:**
- Create: `apps/web/src/components/agent/AgentPlanPanel.tsx`
- Create: `apps/web/src/components/agent/AgentExecutionPanel.tsx`
- Create: `apps/web/src/components/agent/AgentApprovalBlock.tsx`
- Create: `apps/web/src/components/agent/AgentArtifactsPanel.tsx`
- Modify: `apps/web/src/components/agent/AgentEventCard.tsx`

**Step 1: Render plan separately from execution**

Show structured plan steps with explicit step status.

**Step 2: Add approval block**

Display persisted approval state in-page with:
- approve execution
- reject / replan
- allow once / deny for tool approvals when available

**Step 3: Add final result and artifacts**

Render final result separately from execution events and add the artifacts panel on the right side.

**Step 4: Run type check**

Run: `pnpm --filter web exec tsc --noEmit`
Expected: PASS

### Task 11: Add recovery, refresh restore, and background-task rehydration

**Files:**
- Modify: `apps/web/src/stores/agentTaskStore.ts`
- Modify: `apps/web/src/components/agent/AgentWorkbench.tsx`
- Modify: `apps/server/src/routes/agent.ts`

**Step 1: Write the recovery behavior**

On page refresh:
- reload task detail
- restore task status
- restore pending approvals
- restore execution events
- resume task stream subscription when task is still active

**Step 2: Implement task actions**

Wire:
- cancel
- retry
- continue
- replan

**Step 3: Verify manually**

Manual check:
- start a task
- refresh mid-run
- confirm the task detail reloads and still shows the active state

**Step 4: Run type check**

Run: `pnpm --filter web exec tsc --noEmit`
Expected: PASS

### Task 12: Verify end to end and commit

**Files:**
- Modify: `apps/server/src/routes/agent.ts`
- Modify: `apps/server/src/services/agentService.ts`
- Modify: `apps/server/src/services/agentTaskService.ts`
- Modify: `apps/web/src/app/(app)/agent/page.tsx`
- Modify: `apps/web/src/lib/api.ts`
- Modify: `apps/web/src/stores/agentTaskStore.ts`
- Modify: `apps/web/src/components/agent/AgentWorkbench.tsx`
- Modify: `packages/db/src/schema/index.ts`
- Modify: `apps/server/src/db/bootstrap.ts`

**Step 1: Run focused server tests**

Run: `pnpm --filter server exec bun test src/routes/agent.tasks.test.ts`
Run: `pnpm --filter server exec bun test src/services/agentTaskService.test.ts`
Run: `pnpm --filter server exec bun test src/services/agentSdk.test.ts`
Expected: PASS

**Step 2: Run type checks**

Run: `pnpm --filter server exec tsc --noEmit`
Run: `pnpm --filter web exec tsc --noEmit`
Expected: PASS

**Step 3: Run a manual smoke test**

Verify:
- create a task
- generate a plan
- approve execution
- watch execution events
- inspect artifacts
- refresh the page
- reopen the task

**Step 4: Commit**

```bash
git add -f docs/plans/2026-03-19-web-agent-workbench-design.md docs/plans/2026-03-19-web-agent-workbench-v1-implementation-plan.md
git add packages/db/src/schema/index.ts apps/server/src/db/bootstrap.ts apps/server/src/routes/agent.ts apps/server/src/services/agentService.ts apps/server/src/services/agentTaskService.ts apps/server/src/services/agentSdk.ts apps/web/src/app/'(app)'/agent/page.tsx apps/web/src/lib/api.ts apps/web/src/lib/agent-task-stream.ts apps/web/src/stores/agentTaskStore.ts apps/web/src/components/agent/AgentWorkbench.tsx apps/web/src/components/agent/AgentTaskList.tsx apps/web/src/components/agent/AgentTaskHeader.tsx apps/web/src/components/agent/AgentGoalPanel.tsx apps/web/src/components/agent/AgentPlanPanel.tsx apps/web/src/components/agent/AgentExecutionPanel.tsx apps/web/src/components/agent/AgentApprovalBlock.tsx apps/web/src/components/agent/AgentArtifactsPanel.tsx
git commit -m "Build web agent workbench foundation"
```
