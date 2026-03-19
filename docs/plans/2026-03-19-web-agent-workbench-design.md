# Web Agent Workbench Design

**Goal:** Turn the web Agent experience into a task-first workbench that plans before execution, supports approvals, exposes execution state, and preserves structured outputs for later review.

**Product Positioning**
- The web Agent is a remote task workbench, not a local machine controller.
- It should be optimized for planning, remote execution, live research, MCP-backed workflows, and result review.
- Local filesystem edits, local shell execution, and control of the user's current browser tab stay out of scope for this phase.

**Why This Change**
- The current web Agent experience is still message-centric, even though the product intent is task execution.
- Planning, approvals, execution progress, and final outputs are mixed into message and event streams.
- The next stage of Agent capability needs explicit task lifecycle control before adding stronger tools such as remote browser automation.

**Scope**
- Add a task-first web Agent workbench with distinct task, plan, execution, approval, and artifact concepts.
- Separate planning and execution into two explicit phases.
- Support visible task states and resumable long-running work.
- Keep current chat-style Agent flows working during migration.

**Non-Goals**
- No desktop-side local execution in this phase.
- No browser extension for controlling the user's active tab.
- No multi-agent orchestration platform.
- No long-term memory or RAG system in the first version.

## Product Model

The first-class object in the new web Agent is `Task`, not `Message`.

Core objects:
- `AgentTask`: the durable user-facing task container.
- `AgentRun`: one concrete attempt to plan or execute a task.
- `PlanStep`: a structured step in the generated plan.
- `ExecutionEvent`: streamed progress and tool events during execution.
- `ApprovalRequest`: a persisted approval item for plans or high-risk tool uses.
- `Artifact`: a structured result produced by the run.

This model separates:
- what the user wants done,
- how the Agent proposes to do it,
- what happened during execution,
- what outputs were produced.

## User Experience

The web Agent page should become a dedicated three-column workbench.

Left column:
- task list
- task search
- status filtering
- visual emphasis for waiting approvals and failed tasks

Center column:
- task header with state, model, channel, timestamps, and task actions
- goal section for the user's original objective and attachments
- plan section showing structured steps before execution begins
- execution section with progress, tool calls, and errors
- final result section separated from execution noise

Right column:
- artifacts
- sources
- tools
- context

Key interaction rules:
- plan first, then execute
- approvals are explicit task states, not transient popups
- logs and final outputs are separated
- tasks remain recoverable after refresh or navigation

## Task State Machine

The first version uses seven task states:
- `draft`
- `planning`
- `awaiting_approval`
- `running`
- `completed`
- `failed`
- `cancelled`

Execution model:
1. User creates or updates a task goal.
2. Task enters `planning`.
3. Agent returns a structured plan.
4. Task enters `awaiting_approval`.
5. User approves execution.
6. Task enters `running`.
7. Task ends in `completed`, `failed`, or `cancelled`.

Additional transitions:
- `running -> awaiting_approval` for high-risk tool approvals.
- `failed -> running` for continue or retry.
- `failed -> planning` after editing the goal and replanning.

This explicit split between planning and execution is required to support:
- plan review,
- plan approval,
- failure recovery,
- later step-level continuation.

## Backend Design

The existing web Agent endpoints are sufficient for basic session execution but not for a task workbench.

Introduce task-oriented endpoints alongside existing session endpoints:
- `POST /agent/tasks`
- `GET /agent/tasks`
- `GET /agent/tasks/:id`
- `POST /agent/tasks/:id/plan`
- `POST /agent/tasks/:id/execute`
- `POST /agent/tasks/:id/cancel`
- `POST /agent/tasks/:id/retry`
- `POST /agent/tasks/:id/continue`
- `POST /agent/approvals/:id/respond`
- `GET /agent/tasks/:id/events`
- `GET /agent/tasks/:id/artifacts`
- `GET /agent/tasks/:id/stream`

The stream protocol should be event-typed rather than message-typed. First-version event types:
- `task_status`
- `plan_step`
- `execution_event`
- `approval_requested`
- `approval_resolved`
- `artifact_created`
- `final_result`
- `error`
- `done`

Compatibility strategy:
- keep the current `agentSessions` and `agentEvents` flow intact while building the new task path
- migrate the web `/agent` UI to the task path first
- retire or converge old session paths only after the task workbench is stable

## Approval and Governance

The web Agent should not continue scaling capabilities while remaining effectively permissionless.

Approval types:
- `plan_approval`: user approves the generated plan before execution.
- `tool_approval`: user approves a high-risk tool call during execution.

Governance requirements for v1:
- persisted approval state
- per-task status that reflects waiting approvals
- user response handling after refresh
- tool-level policy hooks so approvals are not only UI affordances

This does not require full desktop-style local permissioning yet, but it does require a durable approval model.

## Artifacts

The current result model is too close to message content and tool trace.

The first version should support structured artifacts such as:
- final report
- structured extraction result
- table or list output
- execution summary
- source bundle

Artifacts should be stored and displayed independently from raw execution events so completed tasks remain readable.

## Delivery Strategy

The recommended delivery sequence is:
1. task model and state machine
2. planning flow and plan approval
3. execution workbench and tool approvals
4. artifacts and task recovery

Remote browser automation and stronger MCP composition should come after these foundations are in place.

## Validation

Success criteria for web Agent v1:
- users can create and reopen durable tasks
- the Agent produces a plan before execution
- execution requires explicit approval
- running tasks show progress and tool activity clearly
- failures can be retried or continued
- completed tasks preserve final results and artifacts separately from logs
- page refresh does not lose the task state
