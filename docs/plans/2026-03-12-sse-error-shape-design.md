# SSE Error Shape Compatibility Design

**Date:** 2026-03-12

## Goal

Fix the "Agent send has no reaction" class of issues by making SSE `error` events compatible across consumers:

- Chat currently expects `{ type: 'error', message: string }`
- Agent UI currently expects `{ type: 'error', content: string }`

When the server emits an SSE error with only `message`, Agent renders an empty error card, which looks like "no response".

## Non-Goals

- No automatic retry/fallback model switching.
- No changes to business logic of Agent/Chat beyond error visibility.

## Proposed Change (Approved: Option 1)

### Server: Always include both fields on SSE errors

In `apps/server/src/utils/sse.ts`, when catching an exception inside `createSseStream`:

- Emit:
  - `type: 'error'`
  - `message: <string>`
  - `content: <same string>`

This keeps Chat working (reads `message`) and makes Agent work (reads `content`) without needing per-client special cases.

### Web (Agent): Improve non-OK response errors

In Agent page `handleRun`, if `response.ok === false`:

- Read `await response.text()` best-effort
- Include the text in the error event so users see actionable errors (instead of only "Failed to run agent")

## Acceptance Criteria

- When the Agent run SSE handler throws, the UI shows a visible error event (not blank).
- When `/agent/sessions/:id/run` returns non-OK, the UI shows the concrete error body if any.
- Chat streaming behavior remains unchanged.

