# OpenHorn Chat Streaming Design

## Goal

Add true streaming output for Chat using SSE over `fetch` with POST. Reuse the Agent event format and avoid duplicate logic.

## Scope

- Streaming endpoint for Chat: `POST /messages/stream`
- SSE event format reused from Agent
- Frontend incremental rendering
- Persist assistant message once on stream completion
- Centralized SSE writer shared by Chat and Agent

## Out of Scope

- Incremental DB writes during streaming
- Reconnection or resume
- WebSocket transport
- Agent changes beyond SSE writer reuse

## API

### Request

`POST /messages/stream`

Body:

- `conversationId: string`
- `content: string`

### Response

`Content-Type: text/event-stream`

Events (JSON in `data:`):

- `{ "type": "delta", "content": "..." }`
- `{ "type": "done" }`
- `{ "type": "error", "message": "..." }`

## Server Flow

1. Validate auth and conversation ownership
2. Insert user message + update conversation `updatedAt`
3. Resolve channel + model
4. Stream provider output, emit `delta` events
5. On completion, insert assistant message once
6. Emit `done`

If error mid-stream, emit `error` and close stream.

## Client Flow

1. Send POST with `conversationId` + `content`
2. Create a temporary assistant message in UI
3. For each `delta`, append to the temporary message
4. On `done`, finalize UI state
5. On `error`, replace content with error message

## Duplication Avoidance

Introduce a shared SSE helper in server (e.g. `sse.ts`):

- `writeEvent({ type, ... })`
- `close()`

Both Agent and Chat routes use this helper to serialize and flush events.
