# Desktop Agent Mode Design

## Goal

Rebuild the desktop `Agent` experience around a single, modern agent workflow that is optimized for the latest turn, keeps the UI minimal, and fully exposes Claude Agent SDK-backed execution capabilities such as `bash`, tool use, `MCP`, and `skill` execution without turning the interface into a stack of cards.

## Product Direction

- Ignore historical test conversations as a product constraint.
- Treat the latest user request as the primary agent work surface.
- Prefer a chat-first shell that can temporarily expand into an execution surface during multi-step work.
- Keep the visual language compact, calm, and high-signal.
- Make process visibility optional by default and explicit when risk, approval, or failure requires attention.

## Chosen Interaction Model

The desktop app uses a mixed-mode interaction model:

- At rest, the UI looks like a high-end chat product.
- During active agent execution, the latest assistant response becomes a compact agent response block.
- When execution becomes complex, the response block expands in place into a stronger execution surface.
- When execution completes, the surface collapses back into a clean final-answer-first response.

This keeps the product usable for quick turns while still supporting real agent work.

## Primary UX Principles

1. Final answer first.
2. Current action always visible.
3. Execution details available on demand.
4. Approval is the only intentional interrupt.
5. Process is a unified stream, not multiple card types.

## Information Architecture

Each active agent reply is rendered as one unified response block with four layers:

1. Status line
   Shows one short state string such as `Planning`, `Running command`, `Waiting for approval`, or `Completed`.
2. Current action line
   Shows the highest-priority live action in human language, such as `Inspecting project files` or `Calling GitHub MCP`.
3. Collapsible process stream
   Hidden by default. Shows a flat execution timeline with one row per meaningful event.
4. Final body
   The natural-language result. This remains the dominant visual element after completion.

The UI should not render separate first-class plan, tool, artifact, and approval cards by default.

## Claude Agent SDK Capability Mapping

### Bash

- User-facing label: `Command`
- Default rendering: one humanized action line
- Expanded rendering:
  - command
  - working directory if present
  - short stdout/stderr preview
  - exit status

### Tool Use

- User-facing label: `Tool`
- Default rendering: humanized action label such as `Reading docs` or `Searching the web`
- Expanded rendering:
  - tool name
  - summarized input
  - summarized result

### MCP

- User-facing label: `External capability`
- Default rendering: `Using MCP: <server-name>`
- Expanded rendering:
  - server
  - target object
  - result summary

### Skill

- User-facing label: `Workflow capability`
- Default rendering: `Using review workflow` or similar user-safe text
- Expanded rendering:
  - skill id
  - invocation summary
  - downstream actions triggered by the skill

### Approval

- This is the only state that should break the quiet visual rhythm.
- Render inline inside the unified agent block.
- Two approval types:
  - plan approval
  - dangerous action approval
- Visible controls:
  - `Approve`
  - `Reject`
  - optional `View details`

## State Model

The desktop agent surface should use a reduced state machine:

- `draft`
- `planning`
- `acting`
- `awaiting_approval`
- `resolving`
- terminal: `done`, `failed`, `cancelled`

Internal SDK events may be richer, but the top-level UI should project them into this reduced model.

## Execution Event Model

All process details should map into one event stream with the following categories:

- `thinking`
- `acting`
- `approval`
- `result`
- `artifact`

`acting` is a wrapper category for:

- bash
- tool use
- MCP
- skill execution

This allows the UI to stay visually unified while preserving technical depth in expanded mode.

## Visual Design Rules

- One main container per agent response.
- No nested card stacks.
- Use spacing, typography, and faint separators instead of repeated borders.
- Keep colors restrained; only `approval` and `failed` states should noticeably intensify.
- Use one compact timeline style for all process events.
- Keep animation subtle:
  - soft status transitions
  - minimal live-action pulse

## Desktop-Specific Interaction

- The latest active agent block is the primary execution surface.
- Previous turns remain readable but visually quieter.
- Process expansion should happen inline, not in a modal.
- Long-running execution should not shift the page into a separate tool dashboard.
- The desktop shell should still allow access to Settings and conversation navigation without disrupting execution state.

## Settings Model

The Agent settings page should expose actual task behavior controls, not only provider/search configuration.

Required user-facing controls:

- execution mode default:
  - `Direct`
  - `Compact`
  - `Full`
- reasoning depth default:
  - `Light`
  - `Standard`
  - `Deep`
- default plan approval:
  - on/off
- default auto-start after plan:
  - on/off

Existing provider, Tavily, and MCP settings remain, but they should be framed as capability sources, not as the core of agent mode.

## Data and Architecture Changes

### Current gap

The current desktop app can render task-backed agent messages, but the main composer path still defaults to the older conversation streaming flow.

### Required change

The desktop `Agent` send path should become:

1. create task
2. create assistant placeholder bound to `taskId`
3. request plan or auto-start according to task defaults
4. stream task execution events
5. project events into the unified desktop agent block

The old `message.agentRun.steps` path should become a compatibility fallback rather than the default desktop agent architecture.

## Error Handling

- Authentication/provider/config failures should appear as concise inline error states inside the agent block.
- Tool and bash failures should not explode the layout; they should remain one event in the timeline plus one top-level summary.
- Rejection of plan approval should return the task to `draft` with a clear one-line explanation.
- Dangerous command rejection should clearly say that execution stopped because approval was denied.

## Testing Strategy

### Product behavior

- latest-turn agent request enters unified agent block
- simple task stays compact
- multi-step task expands process stream
- approval pauses execution and renders inline approval controls
- bash/tool/MCP/skill events render as unified process items
- completion collapses back to final-answer-first state

### Technical behavior

- task creation from desktop composer
- state projection from task events to UI state
- event summarization and humanization
- fallback rendering for legacy agent-run messages
- error and retry handling

## Rollout Strategy

### Phase 1

- Unify desktop agent send path on task creation
- Introduce reduced task state projection
- Replace stacked cards with a unified agent block

### Phase 2

- Add approval UX
- Add bash/tool/MCP/skill expanded details
- Add agent behavior defaults in settings

### Phase 3

- Add polish, telemetry, and compatibility cleanup
- Reduce legacy `agentRun.steps` usage to fallback-only

## Success Criteria

- A new desktop `Agent` request always creates a task-backed execution flow.
- Users can understand what the agent is doing without opening multiple cards.
- Approval is obvious and low-friction.
- Claude Agent SDK capabilities are visible and understandable without technical clutter.
- The final experience feels closer to a mature agent product than a chat UI with debug panels attached.
