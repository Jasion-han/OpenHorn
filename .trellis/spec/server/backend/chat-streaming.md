# Chat Streaming Failure Persistence

## 1. Scope / Trigger

Apply when changing Chat send/edit/regenerate streams or sidecar completion.
Provider disconnection is a terminal failure with potentially useful partial
output. It must not erase an already streamed interactive program.
ACP channels expose desktop Agent sessions only. Capability validation must
precede creation or mutation of Chat turns.

## 2. Signatures

```ts
streamReplyUntilStopped(adapter, { model, messages, signal }, send): Promise<{
  content: string;
  stopped: boolean;
  error?: string;
  errorCode?: "response_truncated";
  usage?: ChatUsage;
}>;
// Terminal SSE failure, emitted after persistence:
{ type: "error", message: string, content: string, messageId: string, model: string,
  errorCode?: "response_truncated", usage?: ChatUsage }
class ChatStreamTruncatedError extends Error {
  readonly code = "response_truncated";
  readonly finishReason: string;
  readonly usage?: ChatUsage;
}
class ChatModeUnsupportedError extends Error {
  readonly code = "chat_mode_unsupported";
}
```

## 3. Contracts

- `content` is the exact accumulated provider text. `error` is separate metadata;
  never replace the text with `Error: ...` or append an error inside an unfinished
  code fence. Stop has `stopped: true` and no provider error.
- Send/edit/regenerate persist partial content and update FTS before emitting a
  terminal error. An error carries the actual assistant `messageId` and model,
  including edit-created replies. Emit error or done, never both for one result.
- A regenerate that fails/stops before any new output keeps the previous reply.
  An edit retains the edited question and the replacement's partial/empty reply;
  the previous reply belonged to the previous question.
- Sidecar Chat send uses prepare/complete instead of this SSE helper. The desktop
  must call complete with the prepared assistant id on partial failure as well
  as success; a rejected local stream cannot skip persistence.
- Error text is transmitted separately in the terminal event. No schema change
  is introduced by this contract; the existing message content column retains
  only generated text. The existing TEXT `finish_reason` stores `stopped` for
  Stop, `length` for explicit Chat output truncation, `context_budget_exceeded`
  for a typed local budget rejection, and `error` for other Chat failures.
  Successful replacement clears it; unknown values normalize to null.
- OpenAI `length`, Anthropic `max_tokens`, and Google `MAX_TOKENS` become
  `ChatStreamTruncatedError` only in Chat adapters, after yielding generated
  text and collecting final usage. Missing finish reasons retain gateway
  compatibility. Do not classify generic Agent/tool-call results as this error.
- A truncated Chat turn preserves exact partial/empty content and optional
  provider usage, emits `errorCode: response_truncated`, and stores `length` in
  non-streaming send, streaming send/edit/retry, and sidecar Chat completion.
  SSE terminal metadata includes reported usage so the current bubble and
  reload show consistent counts. Empty truncated content stays empty; the
  localized end label displays the reason outside generated Markdown.
- Stop/cancel takes priority over provider length metadata. A zero-output retry
  keeps the previous content, usage and finish reason; a successful replacement
  clears earlier termination state. No automatic provider retry is introduced.
- Shared `assistantFinishReason(reason, agentRun)` recognizes Chat `length` only
  without a parsed Agent run; a cancelled run produces `stopped` and other
  Agent runs discard Chat length metadata. Agent-mode synchronization must also
  reject `length` when a caller omits its run. This helper owns normalized values
  written to the existing column; it does not require a migration.
- A sidecar Chat error is terminal and unregisters its stream handler. Ignore
  late/duplicate terminal events before mutating the settled turn's metadata.
  Generic Agent error/done lifecycle remains governed by its Agent run.
- Resolve the channel after conversation ownership validation but before writes
  or opening an SSE stream. An ACP Chat request throws ChatModeUnsupportedError;
  routes return JSON HTTP 400 with that code. Apply to send, stream, prepare,
  edit, regenerate and the unknown-assistant regenerate fallback. Do not call a
  completion adapter and discover the capability error after storing a question.
- Sidecar Chat prepare also validates that a resolved channel exists before
  inserting the question; failed preparation cannot leave a dangling turn.
- Persist `conversations.lastMode` when a Chat question is prepared or an Agent
  turn is synchronized. Update it only when that request's user message is the
  conversation's latest user row by SQLite `rowid`; perform this test in the
  same SQL update with `modeForLatestUserRequest`. Timestamps can tie and a
  separate read can race with a newer request. Apply the guard to new Agent
  pairs and both existing-message synchronization branches.
- Chat completion persists its reply without rewriting `lastMode`: a delayed
  completion or retry of an older question cannot replace a newer request's
  saved mode. Conversation ownership validation precedes any mutation.

## 4. Validation & Error Matrix

| Event | Required behavior |
|---|---|
| Provider yields partial, then throws | Persist partial; terminal error has actual id |
| Provider throws before regenerate output | Keep previous reply; emit error |
| Provider throws before edited-question reply output | Keep edited question and empty reply; emit error |
| Provider explicitly reaches Chat output limit | Preserve text/usage, emit structured error, persist length |
| Truncated empty Chat answer | Empty content with visible termination label, never injected error prose |
| Provider reports length after Stop | Store stopped; never relabel as truncated |
| Zero-output truncated retry | Keep previous content/usage/finish reason |
| Late error after Chat completion | Ignore it; never rewrite completed metadata |
| Client cancels after partial | Persist partial with finish_reason=stopped |
| Client cancels empty regenerate | Keep prior reply and its finish reason |
| Normal replacement succeeds | Persist new text and clear old stop state |
| Database persistence fails | Surface the storage failure; do not claim done |
| ACP Chat via any creation/edit/retry path | Typed HTTP 400; messages and conversation unchanged |
| Foreign conversation on an ACP channel | Ownership error before resolving/disclosing channel capability |
| Older Agent sync or Chat prepare overlaps a newer user request | Preserve the newer request's lastMode, including equal timestamps |
| Chat completion arrives after a newer Agent request | Persist the reply without changing the saved Agent mode |

## 5. Good / Base / Bad Cases

- Good: an unfinished `openui` block arrives, the provider disconnects, and the
  same partial source remains after refresh. An error banner identifies failure.
- Base: a successful stream emits deltas and one done event after persistence.
- Bad: throw a provider error before saving the accumulator, or save the error
  message as if it were generated assistant text.

## 6. Tests Required

`messageService.stop.test.ts` uses the real temporary DB and a provider generator
that yields an unfinished UI fence and then throws immediately. Assert send,
edit and regenerate preserve exact partial text, emit a separate error with id,
and emit no done event. Check zero-output failure keeps the previous reply.
Retain all Stop, empty-regenerate and agent synchronization tests.
`messageService.truncation.test.ts` covers explicit output limits with a typed
mock generator and real isolated DB: non-streaming send, SSE send/edit/tail edit/
retry, no-output retry, normal replacement, and sidecar complete/reload state.
`packages/adapters/src/chatStreamError.test.ts` replays all three provider wire
protocols using mocked fetch; no real model request is allowed. Sidecar and
desktop focused tests verify event ordering, optional usage, structured codes,
handler cleanup, refresh labels, empty content, and Agent/Stop boundaries.
`messageService.acp-chat.test.ts` checks all six service paths with real DB
snapshots, ownership ordering, and five actual HTTP route responses. Existing
ACP Agent runtime tests must keep passing.
`messageService.sidecar-mode.test.ts` uses a real temporary SQLite DB to cover
new/existing Agent sync branches, Chat prepare/complete, same-timestamp user
ordering, older retries, trigger-injected interleavings, and foreign ownership.

## 7. Wrong vs Correct

```ts
// Wrong: throwing skips the caller's database write.
catch (error) { if (!signal.aborted) throw error; }
// Correct: return independent text and failure, persist first, then signal it.
catch (error) { if (!signal.aborted) streamError = String(error); }
return { content: accumulated, stopped: signal.aborted, error: streamError };
```

## Scenario: Preserve the Current Request Under Context Budgets

### 1. Scope / Trigger

Apply to Chat send/edit/regenerate preparation, sidecar Chat transport entry
points, and Agent history seeding. A context budget must never turn a user's
request into a system-only provider request.

### 2. Signatures

```ts
// shared/context-budget
boundChatContext<T extends { role: "system" | "user" | "assistant"; content: unknown }>(
  messages: readonly T[],
  limits?: { maxTokens?: number; maxMessages?: number; omittedMessages?: number },
): Array<T | { role: "system"; content: string }>;
// Defaults: CHAT_MAX_CONTEXT_TOKENS = 32_000; CHAT_MAX_CONTEXT_MESSAGES = 200.
class ChatContextBudgetError extends Error {
  readonly code = "chat_context_budget_exceeded";
}
// Sidecar Agent history has a separate 16,000-token allocation.
truncateHistory(history: HistoryMessage[], maxTokens: number): HistoryMessage[];
```

### 3. Contracts

- Token counts are app estimates, not model tokenizer output: text uses
  `ceil(chars / 3.5)`, each message adds 10, and each image adds an estimated
  1,024. Provider context limits still apply. Do not change model/context options
  or claim these estimates are exact token counts.
- Reserve all actual system sections and the complete last user turn before
  choosing older turns. Chat history is grouped by a question and its following
  answers; omit groups from the front, preserving their order and pairing.
  This utility is for Chat messages, not tool-call/result transcripts.
- Count expanded attachment text and the effective system prompt, including
  memory/RAG. A coarse expansion cap preserves stored system messages and the
  current user even when empty assistant placeholders trail it. Normalize and
  merge adjacent roles after budgeting, so an older unanswered question cannot
  consume the current question's protected reservation.
- The desktop appends Auto/UI instructions after server preparation. Reapply
  the shared policy in `runChatStream` and `runCodexChat` before provider/CLI
  startup; count the final schema and retain it in full.
- Any omitted history requires a notice, including complete omission; notice
  tokens and message overhead consume budget. Reject clearly when the complete
  current request, system sections and necessary notice cannot fit. Never clip
  the current user text or silently return only system messages.
- Agent's 16,000-token history allocation excludes its current prompt. Preserve
  that prompt in full and let the runtime/provider surface its own context
  refusal. History notices consume that allocation. `buildHistoryMessages`
  still produces user-first alternating turns, merging a trailing notice/user
  into the final prompt rather than dropping it.

### 4. Validation & Error Matrix

| Condition | Required behavior |
|---|---|
| Current Chat request exceeds local estimate | Clear budget error; no final Chat completion or CLI call |
| Latest historical answer alone exceeds history allocation | Omission notice plus complete current request |
| Auto schema makes prepared history too large | Re-budget at the final sidecar entry; omit whole old turns |
| Current question plus final schema cannot fit | Error before provider request or CLI discovery |
| Count cap would remove stored system/current user | Retain them; enforce the final count and estimate explicitly |
| All history fits exactly without notice | Keep it unchanged; reserve no unnecessary notice |
| History allocation cannot fit even the omission notice | Explicit history-budget failure |

The server's existing live-route classification and RAG embedding work can run
before Chat message construction. This policy gates the final Chat completion
or CLI startup; it does not prevent those earlier optional requests.

### 5. Good / Base / Bad Cases

- Good: omit a large previous generated program, explain the missing history,
  and submit the complete new question with the current Auto schema.
- Base: a small conversation reaches the provider unchanged.
- Bad: break the backwards scan on a large current question and send only
  system instructions; increase budgets to hide the lost-request bug.

### 6. Tests Required

- Shared pure tests assert current-request rejection, all system sections,
  whole-turn history selection, notice cost, 200-message behavior, multipart
  attachments, exact-fit preservation and immutable input.
- `messageService.context-budget.test.ts` calls the real builder without module
  mocks or providers. Cover the 113,000-character request, oversized historical
  answer, adjacent unanswered user turns, stored system retention and more than
  200 trailing empty assistant placeholders. Use a disposable test DB.
- Sidecar `context-budget.test.ts` calls the actual Chat adapter against a
  loopback SSE server: append UI schema after preparation, inspect the submitted
  body, and assert a rejected payload causes zero additional requests. Codex
  rejects before binary discovery. Agent history tests assert the full-omission
  notice, budget compliance, exact fit and normalized alternation.

### 7. Wrong vs Correct

```ts
// Wrong: the latest question can disappear, and the notice is unbudgeted.
if (tokens > remaining) break;
return [system, ...kept];
// Correct: protect the current request, then recheck the final transport body.
const prepared = boundChatContext(expandedMessages);
const submitted = boundChatContext(withCurrentOutputInstructions(prepared));
```

## Scenario: Durable Safe Chat Failure State

### 1. Scope / Trigger

A failure may occur after a question and empty assistant row are stored but
before provider startup. Preserve its reason across the next send and reload.

### 2. Signatures

`MessageFinishReason = "stopped" | "length" | "context_budget_exceeded" | "error"`.
The existing TEXT `messages.finish_reason` stores these values; no migration is
needed. A failed `POST /messages/chat/prepare` returns HTTP 400 with
`{error, code, userMessageId, assistantMessageId}`; `code` is
`chat_context_budget_exceeded` or `chat_preparation_failed`. No credentials or
prepared model context belong in this error response.

### 3. Contracts

- `buildChatMessagesForTurn` catches context-builder failures. New/send/edited
  questions retain an empty assistant row with safe failure state. An edit clears
  the previous question's reply/usage/FTS text; a zero-output retry keeps the
  preceding answer and all its metadata.
- Desktop reconciles both saved IDs before displaying preparation failure. The
  failure is rendered as localized metadata outside the exact generated Markdown;
  never copy raw errors into empty or partial `content`.
- Generic provider errors preserve accumulated text and store `error` in both
  non-streaming and streaming Chat. Sidecar complete receives the same enum.
- Provider output limits and Stop retain their existing precedence; retry success
  clears prior termination state. Agent synchronization accepts `stopped` only
  from this column, and otherwise derives status from its run.
- Both direct and Codex sidecar Chat budget guards emit the structured
  `chat_context_budget_exceeded` code before provider/CLI startup.
- This contract records context-builder and model-stream failures; it does not
  claim every database/network/setup fault has been durably saved.

### 4. Validation & Error Matrix

| Trigger | Stored result |
|---|---|
| Oversized current question at prepare/send/SSE | Empty reply, safe budget state |
| Oversized edited question, including tail edit | Edited question plus empty failed replacement |
| Budget/zero-output error during retry | Previous reply/content/usage/end reason unchanged |
| Provider throws after an unfinished UI fence | Exact partial source plus safe `error` |
| Success after earlier failure | New text and null finish reason |
| Malformed/arbitrary finish reason | Null; raw input is never persisted |
| Agent sync supplies Chat-only failure enum | Discard Chat enum; preserve Agent run semantics |

### 5. Good / Base / Bad Cases

Good: attach oversized synthetic text, see a budget reason, send a short question,
and still see that reason after restart. Base: successful Chat remains unchanged.
Bad: save the error as model prose or rely only on a transient composer banner.

### 6. Tests Required

`messageService.failure-state.test.ts` uses the real isolated DB for prepare,
non-streaming send, SSE send/edit/tail/retry, HTTP saved identities, credentials
exclusion, generic partial failures, completion normalization and successful
clearing. The production browser fixture must send a rejected prepare request,
continue with a short request, reload, and render the localized budget label;
empty and partial generic failure cases keep exact text and a localized label.

### 7. Wrong vs Correct

```ts
// Wrong: a reload turns the failure into a generic empty answer.
content: partial || error.message
// Correct: exact model text and a bounded termination category travel separately.
content: partial, finishReason: chatFailureFinishReason(errorCode)
```
