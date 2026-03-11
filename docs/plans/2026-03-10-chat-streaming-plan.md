# Chat Streaming Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add SSE streaming for Chat with shared event format and minimal duplication, while persisting assistant messages only on completion.

**Architecture:** Introduce a shared SSE writer helper on the server and a shared SSE parser on the client. Add a new `/messages/stream` endpoint that streams `delta` events and ends with `done`, while reusing existing channel resolution logic.

**Tech Stack:** Hono (server), Drizzle ORM + SQLite, Next.js App Router, Mantine UI, Zustand state.

---

### Task 1: Add shared server SSE helper

**Files:**
- Create: `apps/server/src/utils/sse.ts`
- Modify: `apps/server/src/routes/agent.ts`
- Test: `apps/server/src/utils/sse.test.ts`

**Step 1: Write the failing test**

```ts
import { test, expect } from "bun:test";
import { formatSseEvent } from "./sse";

test("formatSseEvent produces SSE data line", () => {
  const result = formatSseEvent({ type: "delta", content: "hi" });
  expect(result).toBe("data: {\"type\":\"delta\",\"content\":\"hi\"}\\n\\n");
});
```

**Step 2: Run test to verify it fails**

Run: `cd apps/server && bun test src/utils/sse.test.ts`  
Expected: FAIL (module not found).

**Step 3: Write minimal implementation**

```ts
export type SseEvent = { type: string; [key: string]: unknown };

export function formatSseEvent(event: SseEvent): string {
  return `data: ${JSON.stringify(event)}\\n\\n`;
}

export function createSseStream(
  handler: (send: (event: SseEvent) => void) => Promise<void>
): ReadableStream {
  return new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      const send = (event: SseEvent) => {
        controller.enqueue(encoder.encode(formatSseEvent(event)));
      };
      try {
        await handler(send);
      } catch (error) {
        send({ type: "error", message: error instanceof Error ? error.message : "error" });
      } finally {
        controller.close();
      }
    },
  });
}
```

**Step 4: Run test to verify it passes**

Run: `cd apps/server && bun test src/utils/sse.test.ts`  
Expected: PASS.

**Step 5: Refactor Agent to use helper**

Modify `apps/server/src/routes/agent.ts` to build the stream via `createSseStream`, reusing existing agent event emission.

**Step 6: Commit**

```
git add apps/server/src/utils/sse.ts apps/server/src/utils/sse.test.ts apps/server/src/routes/agent.ts
git commit -m "feat: add shared SSE helper and use in agent"
```

### Task 2: Add streaming message service and endpoint

**Files:**
- Modify: `apps/server/src/services/messageService.ts`
- Modify: `apps/server/src/routes/messages.ts`
- Test: `apps/server/src/services/messageService.stream.test.ts`

**Step 1: Write the failing test**

```ts
import { test, expect } from "bun:test";
import { buildChatMessages } from "./messageService";

test("buildChatMessages includes system prompt when present", async () => {
  const result = buildChatMessages(
    [{ role: "user", content: "hi" }],
    "system here"
  );
  expect(result[0]?.role).toBe("system");
});
```

**Step 2: Run test to verify it fails**

Run: `cd apps/server && bun test src/services/messageService.stream.test.ts`  
Expected: FAIL (export missing).

**Step 3: Write minimal implementation**

- Add `buildChatMessages()` helper to reuse between `sendMessage` and `streamMessage`.
- Add `streamMessage(userId, input)` that returns `ReadableStream` using `createSseStream`.
- During stream:
  - emit `delta` events
  - collect content
  - insert assistant message after stream completes
  - emit `done` with `{ messageId, model }`

**Step 4: Run test to verify it passes**

Run: `cd apps/server && bun test src/services/messageService.stream.test.ts`  
Expected: PASS.

**Step 5: Wire new route**

Add `POST /messages/stream` in `apps/server/src/routes/messages.ts`, returning `text/event-stream` with the stream from `streamMessage`.

**Step 6: Manual smoke test**

Run server, then:

```
curl -N -H "Content-Type: application/json" \
  -d '{"conversationId":"<id>","content":"hello"}' \
  http://localhost:3000/messages/stream
```

Expected: SSE `data:` lines with `delta`, then `done`.

**Step 7: Commit**

```
git add apps/server/src/services/messageService.ts apps/server/src/routes/messages.ts apps/server/src/services/messageService.stream.test.ts
git commit -m "feat: add chat streaming endpoint"
```

### Task 3: Add client SSE parser and stream API

**Files:**
- Create: `apps/web/src/lib/sse.ts`
- Modify: `apps/web/src/lib/api.ts`
- Test: `apps/web/src/lib/sse.test.ts`

**Step 1: Write the failing test**

```ts
import { parseSseLines } from "./sse";

const events = parseSseLines("data: {\"type\":\"delta\",\"content\":\"hi\"}\\n\\n");
if (events.length !== 1 || events[0].type !== "delta") {
  throw new Error("failed");
}
```

**Step 2: Run test to verify it fails**

Run: `node apps/web/src/lib/sse.test.ts`  
Expected: FAIL (module not found).

**Step 3: Write minimal implementation**

- Implement `parseSseLines(buffer: string)` returning parsed events and remaining buffer.
- Implement `readSseStream(response, onEvent)` that reads `response.body` and calls `onEvent`.
- Add `api.messages.stream()` that returns `fetch` response from `/messages/stream`.

**Step 4: Run test to verify it passes**

Run: `node apps/web/src/lib/sse.test.ts`  
Expected: PASS.

**Step 5: Commit**

```
git add apps/web/src/lib/sse.ts apps/web/src/lib/sse.test.ts apps/web/src/lib/api.ts
git commit -m "feat: add SSE parser and chat stream API"
```

### Task 4: Update Chat UI to stream

**Files:**
- Modify: `apps/web/src/components/ChatArea.tsx`
- Modify: `apps/web/src/hooks/useChat.ts` (only if needed)
- Modify: `apps/web/src/app/agent/page.tsx`

**Step 1: Write the failing test**

Add a small runtime check script to ensure ChatArea uses the stream method:

```ts
import { api } from "../lib/api";
if (!api.messages.stream) {
  throw new Error("stream method missing");
}
```

Run: `node apps/web/src/lib/chat-stream.check.ts`  
Expected: FAIL initially.

**Step 2: Write minimal implementation**

- In `ChatArea`, replace `api.messages.send` with streaming logic:
  - create temp assistant message
  - append deltas
  - on `done`, mark streaming false and optionally replace temp id using `messageId`
  - on `error`, show error content
- Extract SSE parsing into `apps/web/src/lib/sse.ts` and reuse in `agent/page.tsx` to avoid duplicate parsing logic.

**Step 3: Run manual verification**

- Open chat UI, send a message, confirm the assistant text streams in.
- Confirm `isStreaming` toggles correctly and errors render.

**Step 4: Commit**

```
git add apps/web/src/components/ChatArea.tsx apps/web/src/app/agent/page.tsx apps/web/src/hooks/useChat.ts
git commit -m "feat: stream chat responses in UI"
```

---

## Notes

- This repo is not a git repository, so commit steps are placeholders unless git is initialized.
- If `bun test` is unavailable, replace test steps with `node` runtime checks as noted.
