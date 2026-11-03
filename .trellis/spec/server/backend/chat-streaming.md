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
// Legacy helper defaults: 32_000 tokens / 200 messages. Runtime callers pass model policy.
class ChatContextBudgetError extends Error {
  readonly code = "chat_context_budget_exceeded";
}
// Legacy helper only; production Agent entries use boundAgentHistory and model policy.
truncateHistory(history: HistoryMessage[], maxTokens: number): HistoryMessage[];
```

### 3. Contracts

- Token counts are app estimates, not model tokenizer output: ASCII uses
  `ceil(chars / 3.5)`, BMP non-ASCII adds2 per code point, supplementary characters
  add4; each message adds10 and each image an estimated1024. Model-aware runtime
  limits come from shared/context-policy, including output/tool/safety reserves.
  Provider tokenization and native compaction remain authoritative.
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
- Agent reserves full current text/files, effective system instructions, tool
  definitions and images before choosing older whole turns with the same model
  policy. No active16K history allocation remains. `buildHistoryMessages` still
  produces user-first alternating turns. Growing self-managed tool transcripts
  fail intact rather than splitting tool-call/result pairs.

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


## Scenario: Model-Aware Context Capacity

### 1. Scope / Trigger
All Chat send/edit/retry/prepare and sidecar Chat/Agent entries, channel model
configuration, metadata discovery, Codex exec/app-server, ACP dynamic model credentials and DB upgrades.

### 2. Signatures
`ModelContextConfig = {contextWindow?: number | null, contextMetadata?: ModelContextMetadata | null}` in shared/types.
`resolveContextPolicy({model,protocol?,contextWindow?,mode?})` returns
`{contextWindow,maxInputTokens,maxOutputTokens,maxMessages,reserveTokens,source}`.
`channel_models.context_window INTEGER NULL` exists in both schema definitions;
bootstrap adds it idempotently before FK rebuilding. `PUT /channels/:id/models`
accepts the optional field; `GET /channels/:id/credentials?modelId=...` resolves
that exact model. Chat prepare returns the raw manual contextWindow override
and contextMetadata; desktop forwards
it through validated chat.stream/agent.run RPCs, including background Agent runs.

### 3. Contracts
- Null means automatic; omission in legacy update payloads preserves overrides.
  Sync, backup and import retain explicit values. Integer8192..2000000 required.
- Exact verified model IDs/snapshots use documented capacities; unknown IDs fall
  back to32000 and may receive a channel-specific override. Overrides cannot
  increase known maxima. Old conversation.contextLength4096 is not an override.
- Astra window1050000 has a distinct922000 input ceiling. Reserve output4096
  (Chat) /16384 (Agent), capped at window/4; safety max(1024,ceil(window*5%));
  Agent tool reserve min(32768,floor(window/8)). Input also obeys documented
  model input maxima. Message cap scales with input/64, bounded200..10000.
- Expand current attachments/instructions before old turns. Expand old groups
  newest-first and stop after the first non-fitting group, counting unfetched
  rows in omission metadata. Do not read10000 obsolete attachments first.
- Codex Chat uses stdin via exec '-' for user/history and no second16K crop;
  developer instructions retain their role, with a separate64KiB encoded argv
  ceiling checked before spawning. Capacity/compaction overrides are per run,
  never writes to user CLI configuration. Native Agent uses JSON-RPC.
- ACP live model IDs need not exist in persisted models; only an exact persisted
  match can supply its override. External resumed native history/compaction is
  owned by the external runtime; app estimates cover the incoming seeded request.

### 4. Validation & Error Matrix
| Input | Result |
|---|---|
| Known Astra plus >32K current estimate | Accepted if protected input fits922000 and reserves |
| Unknown gateway alias with1000000 override | Budget from override; do not infer provider support |
| Zero/string/fraction/NaN/over2M override | Reject writes/RPC; invalid resolver input uses automatic fallback |
| Exact known model with too-large override | Clamp documented maximum |
| Explicit null / omitted update field | Reset to automatic / retain prior setting |
| Unknown HTTP model / live ACP model | Reject selection / allow without inheriting default override |
| Current request or required notice cannot fit | Explicit durable Chat failure, no final completion |

### 5. Good / Base / Bad Cases
Good: Astra large file with random first/last markers retains both, including
Agent file text beyond12000 characters. Base: small requests unchanged.
Bad: update32K constant while Codex16K history or attachment clipping remains.

### 6. Tests Required
Shared exact IDs/ceilings/overrides/Unicode/count scaling; server selected model,
all Chat paths and10000-row attachment fetch bounds; old missing-column schema
migration preserves every old row and repeated overrides. Desktop mapping/query,
explicit-save input validation and manual/background transport parity. Sidecar
actual loopback JSON contains complete files/history; fake Codex process receives
390K stdin and per-thread metadata, oversized system argv fails before spawn.
Retain native real-GPT evidence separately from deterministic protocol coverage.

### 7. Wrong vs Correct
Wrong: model.contextWindow=128000 while truncateHistory(history,16000).
Correct: selected model/channel resolves one policy used in preparation, final
wire payload and runtime metadata; native provider limits remain authoritative.

Official model sources (verified2026-11-02):
https://developers.openai.com/api/docs/models/gpt-6-astra.md
https://developers.openai.com/api/docs/models/gpt-5.5.md
https://developers.openai.com/api/docs/models/gpt-5.4.md
https://developers.openai.com/api/docs/models/gpt-4.1.md
https://platform.claude.com/docs/en/about-claude/models/overview


## Scenario: Automatic Capability Discovery Across Providers

### 1. Scope / Trigger
Model sync, metadata-only refresh, first/stale selected-model resolution and all
Chat/Agent final payloads. Capacity is provider/channel-specific; never guess1M
from a model name or protocol, and never use inference to probe a limit.

### 2. Signatures
`ModelContextMetadata = {contextWindow:number,maxInputTokens?:number,
maxOutputTokens?:number,source:'channel'|'catalog'|'runtime',fetchedAt:number,
inputLimitOnly?:boolean}`. Shared normalizer validates4096..16777216 context,
positive independent token ceilings, numeric safe timestamp and source enum.
`channel_models.context_metadata TEXT NULL` is additive, mirrored in Drizzle and
bootstrap, and read through the normalizer. It is server-owned: manual model
update payloads do not write it. `POST /channels/:id/context-capabilities`
returns `{success,models,updated,error?}` and changes metadata only.

### 3. Contracts
- Manual budget choice is bounded by discovered hard limits. Automatic priority:
  configured channel report, exact maintained public catalog match, verified
  built-in snapshot, explicit conservative32K fallback. Current metadata can
  supersede old built-in context; independent input/output ceilings still apply.
- OpenRouter context_length/top_provider and endpoint max_prompt_tokens /
  max_completion_tokens remain distinct. Endpoint detail is fetched for the
  selected model only. Google inputTokenLimit/outputTokenLimit and Anthropic
  max_input_tokens/max_tokens are not summed into an invented total window;
  input-only reports are labelled and budgeted conservatively. Output alone
  cannot establish a context window.
- Preserve exact serving IDs and namespaces. Only Google's models/ transport
  prefix is stripped. Catalog matches exact serving/canonical IDs; ambiguity
  stays unknown. Public catalog downloads receive no credentials, conversation
  content or private aliases. Provider auth stays on its configured origin;
  pagination cannot redirect credentials to another origin.
- Bound network work:12s cold directory deadline,16MiB body,20pages,20000models;
  catalog single-flight/cache24h with60s failure backoff. Channel metadata
  refresh is single-flight/scoped to channel identity and cached24h. Future
  timestamps are not fresh. First/stale resolution can refresh once; failures
  retain valid scoped metadata and preserve manual choices.
- Partial new reports retain missing last-good input/output ceilings before
  catalog supplementation. Provider key/endpoint/protocol changes clear old
  metadata; both model sync and metadata-only writes recheck channel identity
  inside the write transaction. Model roster additions invalidate channel
  refresh cache; numeric override edits do not trigger needless network work.
- Metadata-only refresh never deletes/adds models or changes enabled/default /
  manual overrides. Normal sync still reconciles its model list and also stores
  capacity reports. Display source and timestamp; unknown32K is a conservative
  app budget, never presented as measured model capacity.
- Prepare and credentials return raw manual contextWindow|null plus validated
  contextMetadata. Do not put effective discovered16M into the manual8192..2M
  RPC field. Desktop/manual/background runs and every sidecar entry propagate
  metadata, so final bounds and requested output retain independent limits.

### 4. Validation & Error Matrix
| Trigger | Required behavior |
|---|---|
| Namespaced OpenRouter Claude/Gemini/other model reports capacity | Use that exact model's report; no GPT registry required |
| Directory has IDs only | Exact public catalog fallback, then builtin/unknown |
| Output limit only | Unknown context, never treat output as context |
| Directory later omits valid input/output fields | Keep last scoped ceilings |
| HTTP/timeout/malformed/catalog outage | Preserve cached data/manual override; bounded retries |
| Concurrent channel edit while sync/refresh runs | Discard obsolete write inside transaction |
| New model after warm cache | Invalidate roster-dependent cache; resolve new model immediately |
| Auto discovered4096 or2097152/16M | Valid metadata with manualnull, no RPC range rejection |

### 5. Good / Base / Bad Cases
Good: OpenRouter reports Gemini/Claude/Qwen capacities with sourcechannel, while
an unidentifiable private alias explicitly shows unknown/conservative budget.
Base: manualoverride and old successful conversations remain intact.
Bad: a static list grants GPT1M while other valid models remain silently32K;
or a partial refresh loses a1024output ceiling and starts requesting16384.

### 6. Tests Required
Directory parser/protocol fields/pagination/redirect/byte+deadline bounds;
catalog cache/single-flight/backoff/exact namespaced lookup; selected OpenRouter
endpoint details; DB migration/read-only metadata+manual preservation; partial
reports and deferred network/channel edits; roster cache invalidation;2M+auto
prepare-to-sidecar transport. Non-GPT262144context/200000input/1024output must
reach real loopback OpenAI/Google/Anthropic Chat and Direct Agent requests;
Codex native transport receives metadata without invented output config keys.
UI source/unknown projection, refresh route and per-model mapping have regressions.

### 7. Wrong vs Correct
Wrong: `/models` mapped only to{id,displayName}, then a hardcoded model registry.
Correct: retain validated limits/source/time, refresh/cache per channel identity,
resolve one policy and carry its raw manual+metadata inputs to the final runtime.

Sources: https://openrouter.ai/docs/guides/overview/models ;
https://openrouter.ai/docs/api/api-reference/endpoints/list-all-endpoints-for-a-model ;
https://ai.google.dev/api/models ;
https://raw.githubusercontent.com/anthropics/anthropic-sdk-typescript/main/src/resources/models.ts ;
https://models.dev/models.json .


Metadata network requests respect explicit HTTP(S)/ALL_PROXY and NO_PROXY. On
macOS, absent environment routing, read existing scutil settings (500ms read,
30s cache/single-flight), honoring exceptions/loopback/CIDRs without changing
system settings. PAC is not fetched/evaluated; explicit environment routing
remains authoritative. Only read-only metadata requests use this helper, not
all inference transports. Native cold OpenRouter fetch took6.4s, motivating the
12s bounded concurrent directory/catalog/selected-detail phase; warm reads use
caches. Public OpenRouter directory calls send no inference credentials. Explicit
refresh bypasses catalog TTL, and cache-only outage returns a warning without
claiming newly fetched facts or erasing valid limits.


### Server Test Database Boundary

Bun's per-package preload is directory-dependent. Server tests must pin isolated
DATABASE_URL/OPENHORN_TEST_DATABASE_URL and load apps/server/bunfig.toml setup.
As a second boundary, db/index calls assertIsolatedTestDatabase before createClient
when NODE_ENV=test. Selecting the default workspace data/openhorn.db, including
relative/encoded/query URLs and symlink/hardlink aliases, throws
UnsafeTestDatabaseError(code=unsafe_test_database) without opening SQLite.
Temporary databases, :memory: and normal development/production behavior remain
unchanged. Regression subprocesses copy the real entry/helper into an owned
synthetic workspace: even a broken guard cannot target the user's normal DB.


### Automatic Discovery When Adding Models

The normal new-channel editor creates a channel and immediately synchronizes its
model directory, including capability metadata. Manual roster updates must also
resolve new models before returning: updateChannelModels computes new IDs, commits
its transaction, invalidates the roster-dependent cache and awaits one bounded
best-effort metadata-only refresh. The existing UI reload then displays returned
limits without a manual refresh or first inference request. A single added
OpenRouter routing alias gets selected-endpoint lookup; bulk additions share one
directory/catalog phase and leave unavailable endpoint details to normal per-run
resolution. Never use authoritative fetchChannelModels for manual Add, because
its reconciliation can remove manually configured aliases.

Include disabled new IDs, preserve manual overrides/defaults/enabled settings,
and do not repeat discovery for numeric edits, toggles or removals. Network work
stays outside the write transaction. A discovery failure never rolls back a
successfully saved model; it remains visibly unknown and normal resolution retries
under existing backoff. Tests seed pre-existing rows directly so fixture setup
does not accidentally invoke the Add workflow before mock transports are installed.
Required regressions: immediate returned/persisted provider limits, IDs-only catalog
fallback, new-channel create+sync, unlisted OpenRouter detail, offline preservation,
disabled new models and zero extra network work for existing-model edits/removal.

### Selected Endpoint Cache and Fresh Credential Snapshots

#### 1. Scope / Trigger

OpenRouter model selection after directory/catalog discovery, explicit capacity
refresh, delayed metadata writes, and ACP runtime credential delivery.

#### 2. Signatures

- `loadOpenRouterModelContext(modelId, { force?: boolean })`.
- `invalidateOpenRouterModelContexts(modelIds: readonly string[])`.
- Existing `POST /channels/:id/context-capabilities` and
  `GET /channels/:id/credentials?modelId=...` keep their public payloads.

#### 3. Contracts

Directory/catalog `maxInputTokens` does not prove selected endpoint validation.
Use the endpoint cache for every selected OpenRouter model, including after
joining another channel refresh. Ordinary hot reads issue no new request;
failed reads back off and keep last-good limits. Explicit channel refresh expires
only its roster's endpoint entries; selected detail can bypass TTL/backoff.
Do not query every model endpoint during a channel refresh. In-flight requests
remain shared, including forced calls; invalidation does not cancel them.

A report marked `inputLimitOnly` supplies an input ceiling, not a measured total
window. Aggregate true totals separately from input ceilings; an output-only
endpoint can constrain output when another report establishes context, but cannot
establish context by itself. Keep the marker
only when no true total exists. Merge a delayed detail response with the current
model row inside the identity-guarded transaction, preserving independently
stricter limits. Normal model synchronization also re-reads current metadata in
its write transaction. Avoid rewriting unchanged metadata on hot reads.

Persisted enabled ACP model IDs use the freshly resolved model's manual window
and metadata. Only IDs absent from the persisted roster qualify as live-only;
they use exact catalog fallback and never inherit the launch model's override.
A persisted disabled model cannot bypass validation through that fallback.

#### 4. Validation & Error Matrix

| Trigger | Required behavior |
|---|---|
| Directory input100K, endpoint input32K/output1K | Selected run uses endpoint ceilings |
| Explicit refresh with warm endpoint cache | Next selected read revalidates that model |
| Endpoint outage after a valid report | Preserve known limits and bounded backoff |
| Total128K plus input-only64K | Retain total128K and input64K separately |
| Total128K/output8K plus output-only1K | Retain total128K and output1K |
| Delayed detail races a stricter saved report | Retain stricter current limits |
| Persisted ACP metadata refreshed during credentials request | Return new metadata on that same request |
| Disabled persisted ACP ID requested | Reject; do not treat as live-only |

#### 5. Good / Base / Bad Cases

Good: lazy selected-detail enrichment tightens input/output without scanning the
whole roster. Base: repeated selection uses cached metadata without network I/O.
Bad: treat an input field as endpoint provenance, or return credentials from a
snapshot read before capability hydration.

#### 6. Tests Required

Cover directory and catalog input fields with tighter endpoint limits, explicit
force/invalidation and unrelated-cache preservation, single-flight/backoff,
input-only and mixed-total endpoint aggregation, delayed-response merge, and ACP
first-request refreshed credentials/live-only/disabled/ownership behavior.
Use isolated server databases and deterministic metadata transports.

#### 7. Wrong vs Correct

Wrong: `if (!metadata.maxInputTokens) fetchDetail()`; read ACP metadata from the
pre-hydration channel snapshot. Correct: endpoint cache owns discovery state;
the resolved exact model owns the credential response's capacity fields.

## Conversation Ownership, Search Replacement and Usage

### 1. Scope / Trigger

Chat request acceptance/completion, sidecar completion of an assistant row,
full-text replacement, and normal non-streaming Chat usage accounting.

### 2. Signatures

Existing `sendMessage`, `streamMessage`, `completeChatFromSidecar` and
`searchMessages` public shapes remain unchanged. Reuse
`modeForLatestUserRequest(conversationId, userMessageId, mode)` for request-time
mode writes. Adapter async generators return optional `ChatUsage` on completion.

### 3. Contracts

Request acceptance owns conversation mode, subject to the latest-user SQL guard;
completion of an older Chat answer never changes a newer request's mode. Cover
both streamed and non-streamed Chat and equal-timestamp request ordering.

Sidecar Chat completion validates and writes only the requested conversation's
actual Chat assistant row, with compatible legacy null-mode rows allowed. It
must not rewrite a user row, an Agent run or another conversation's message.
Invalid IDs produce no message/index mutation. Full-text replacement deletes
old indexed content even when the replacement body is empty. Search joins both
message ID and conversation ID, so inconsistent index rows cannot supply
unrelated message metadata. Keep the existing optional-index compatibility.

Consume the async generator's terminal return to preserve real optional usage.
A reported zero-token usage object is valid; an absent report stays absent.
Truncation/partial-text/error behavior remains covered by its existing contract.

### 4. Validation & Error Matrix

| Trigger | Expected behavior |
|---|---|
| Old Chat finishes after a newer Agent request | Keep the newer Agent mode |
| Non-stream Chat begins in an Agent-history conversation | Save Chat only if this user request is latest |
| Reply text becomes empty | Retain empty reply and remove old search matches |
| Complete target is missing, foreign, user or Agent | Reject without message/index writes |
| FTS message and conversation IDs disagree | Exclude the row from search |
| Generator returns usage, including zeros | Store and return that exact usage |
| Generator returns no usage | Do not fabricate a report |

### 5. Good / Base / Bad Cases

Good: completion updates the exact prepared Chat answer while a newer user
choice remains intact. Base: normal replies and search results retain their
existing payloads. Bad: indexing an arbitrary ID after an UPDATE affected no
rows, or using `for await` while expecting its discarded return value to contain
usage.

### 6. Tests Required

Gate old Chat provider completion and request-start mode writes against newer
Agent users, including equal timestamps. Verify actual empty/replaced text search,
invalid-target immutability, mismatched FTS exclusion, legacy Chat compatibility,
and real adapter terminal usage with normal/zero/missing reports. Use an isolated
DB and synthetic local provider; never run against the normal app database.

### 7. Wrong vs Correct

Wrong: set `lastMode: "chat"` when the provider finishes; skip FTS work when the
replacement is empty. Correct: guard mode at request acceptance and always clear
the old index entry before optionally inserting the replacement text.

## Active Mutation Ownership and Attachment Visibility

### 1. Scope / Trigger

Overlapping Chat retry/edit requests, deletion during preparation/generation,
attachment binding, document indexing and RAG retrieval.

### 2. Signatures

Public Chat request/response shapes remain unchanged. Active mutation ownership
is internal to this server process's asynchronous work, not a distributed revision
protocol. `linkAttachmentsToMessage(ids, messageId, userId, writer?)` returns the
actual bound IDs; an optional transaction writer reuses its caller's transaction.

### 3. Contracts

Retry and edit share request ownership for their question/answer identities.
Allocate request order before asynchronous preparation; delayed older setup must
not steal a newer owner. Superseded/deleted work cannot publish or persist late
text, usage, finish state, preparation errors or index changes. A normal client
Stop remains distinct: the current owner may persist partial output, and a
zero-output retry retains its previous answer. Finally releases only that exact
owner. Conversation deletion invalidates matching active work only after its SQL
transaction commits; a rollback must leave the active request intact. An empty
reserved reply is removable only while it remains a Chat placeholder without an
Agent run; do not delete a tool-only Agent reply whose derived text is empty.
Validate live owned rows in the transaction before reserving a tail reply
or saving a terminal result; deleted questions must not produce new replies.

An attachment can bind only to an owned user message in its own conversation,
or an explicitly matching legacy session scope, and cannot move from another
message. Exact-target retries are idempotent. Mixed foreign/conflicting IDs are
ignored compatibly, and the stored message ID list reflects actual bindings.

SQL attachment/conversation ownership is authoritative for RAG visibility; vector
rows are a derived index. Validate indexing sources before/after asynchronous
embedding and vector writes. Stop later embedding batches after deletion and
clean late vector writes. Revalidate retrieved sources after vector search so
stale/deleted/foreign/mismatched chunks cannot enter the prompt. Post-commit
message deletion also cleans its attachment vectors; retrieval remains safe even
if that best-effort cleanup fails or loses a race. Never delete user-local files
represented by `local:` metadata markers.

### 4. Validation & Error Matrix

| Trigger | Expected behavior |
|---|---|
| Old retry completes after new retry/edit | Keep the newer answer and index |
| Stopped old retry returns partial text after replacement | Do not overwrite the new owner |
| Older preparation resumes after a newer request | Do not call its provider or persist its failure |
| Edited tail question is deleted during setup | No orphan reply or provider call |
| Source deleted during embedding/vector commit/search | No deleted text in later retrieval |
| Another message already owns an attachment | Do not move its binding or advertise a false binding |
| No live document source remains | Skip paid query embedding |

### 5. Good / Base / Bad Cases

Good: a new retry owns the answer while the old request winds down; stale vector
rows remain invisible after their SQL source is deleted. Base: one normal Chat
request and a fresh same-conversation upload retain their existing behavior.
Bad: treat abort delivery as write ownership, or trust vector row existence as
proof that a document is still available to the user.

### 6. Tests Required

Use deterministic provider/preparation gates for retry/retry, retry/edit, Stop and
deletion ordering, including failure/empty-output preservation. Real isolated SQL
fixtures plus synthetic vector/embedding modules cover binding ownership,
message-ID projection, deletion before/during/after indexing, multi-batch stop,
retrieval races, foreign/mismatched sources and failed-cleanup visibility.
Never access normal SQL/vector databases or real embedding/model services.

### 7. Wrong vs Correct

Wrong: save every late stream by assistant ID, or append every returned vector
chunk to a prompt. Correct: guard writes with the active mutation and live rows;
filter retrieval through current relational source ownership.
