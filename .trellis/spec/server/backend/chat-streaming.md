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
}>;
// Terminal SSE failure, emitted after persistence:
{ type: "error", message: string, content: string, messageId: string, model: string }
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
  only generated text, and finish_reason retains its existing Stop semantics.
- Resolve the channel after conversation ownership validation but before writes
  or opening an SSE stream. An ACP Chat request throws ChatModeUnsupportedError;
  routes return JSON HTTP 400 with that code. Apply to send, stream, prepare,
  edit, regenerate and the unknown-assistant regenerate fallback. Do not call a
  completion adapter and discover the capability error after storing a question.
- Sidecar Chat prepare also validates that a resolved channel exists before
  inserting the question; failed preparation cannot leave a dangling turn.

## 4. Validation & Error Matrix

| Event | Required behavior |
|---|---|
| Provider yields partial, then throws | Persist partial; terminal error has actual id |
| Provider throws before regenerate output | Keep previous reply; emit error |
| Provider throws before edited-question reply output | Keep edited question and empty reply; emit error |
| Client cancels after partial | Persist partial with finish_reason=stopped |
| Client cancels empty regenerate | Keep prior reply and its finish reason |
| Normal replacement succeeds | Persist new text and clear old stop state |
| Database persistence fails | Surface the storage failure; do not claim done |
| ACP Chat via any creation/edit/retry path | Typed HTTP 400; messages and conversation unchanged |
| Foreign conversation on an ACP channel | Ownership error before resolving/disclosing channel capability |

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
`messageService.acp-chat.test.ts` checks all six service paths with real DB
snapshots, ownership ordering, and five actual HTTP route responses. Existing
ACP Agent runtime tests must keep passing.

## 7. Wrong vs Correct

```ts
// Wrong: throwing skips the caller's database write.
catch (error) { if (!signal.aborted) throw error; }
// Correct: return independent text and failure, persist first, then signal it.
catch (error) { if (!signal.aborted) streamError = String(error); }
return { content: accumulated, stopped: signal.aborted, error: streamError };
```
