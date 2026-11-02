# Generative UI in Answers

> Interactive answers rendered from fenced code blocks. Implemented 2026-10-31
> (task `10-31-ui-html`).

## Contract

A model puts UI inside an ordinary Markdown answer with fenced blocks:

| Fence | Rendered by | Runs |
|---|---|---|
| ` ```openui-lang ` (or ` ```openui `) | `components/chat/genui/GenUiBlock.tsx` (OpenUI Lang 1.0 `Renderer`) | The desktop component library; state in `$variables`, no further model call |
| ` ```html-ui ` | `components/chat/genui/HtmlUiBlock.tsx` | A sandboxed iframe |

Fences, not tool calls, because Codex CLI and ACP agents have tool sets we do
not control; the same text works for every runtime and for chat mode.

The block is detected in `DesktopMarkdownMessage`'s `code` renderer
(`lib/genui/fence.ts`). `endsInsideOpenFence` uses micromark's CommonMark + GFM
tokens, matching ReactMarkdown, including quote/list containers and HTML blocks.
Only an unclosed fenced block at the current text tail is "streaming"; earlier
blocks become interactive as soon as their fences close. Do not replace this
with a separate fence-line regex.

## Prompt contract

- The component names, argument order and option values in
  `components/chat/genui/components.tsx` are what models are taught to write.
  Changing them changes the prompt; `prompt.test.ts` parses every example
  against the library and fails on unknown components or `@functions`.
- Response format is a per-machine Settings preference: Auto (default) or
  Text only. The shared composer has no Interactive chip. Retain the existing
  `openhorn.genUi.enabled` boolean storage: absent/invalid/blocked storage uses
  Auto, saved `true` uses Auto, and explicit saved `false` remains Text only.
  Do not collapse absent and false during migration or overwrite a saved opt-out.
- Auto builds the component protocol from the library (`buildGenUiSystemPrompt`)
  and lets the model choose text or useful interactive content in the same
  request. Honor explicit text/Markdown/source requests. Agent file edits,
  commands and builds must be performed with actual tools; an inline widget
  cannot substitute for completing the user's task. Do not add a classifier
  model call or a keyword router merely to choose answer presentation.
- Text only sends a short explicit output policy allowing ordinary Markdown
  and source fences while excluding new `openui-lang` / `html-ui` blocks. It
  must not import/send the full component schema, forbid Agent tools, or disable
  historical widget rendering. Omitting UI instructions alone is not a reliable
  Text-only contract. The policy governs future generations, retries and edits.
- Both policies travel through `lib/genui/promptMerge.ts` at every Chat/Agent
  send, retry and edit site in `DesktopChatArea`. Read the current preference
  when executing callbacks, including memoized historical bubbles. Chat retry
  and edit pass the selected policy as `appendSystemPrompt` (server:
  `services/appendSystemPrompt.ts`, 32,000-char cap → 400); the server appends it
  for that one call and never persists it. Test all six paths and live changes.
  Local prompt-string caching is not evidence of free provider input tokens;
  measure provider context costs separately from lazy renderer bundle loading.
- Local vs. model interactions (task `10-31-genui-local-actions`): anything
  computable from data the block already has (mode / view switch, filter,
  sort, details) is a `$variable` + `@Set` / an input + ternary inside the
  block. `@ToAssistant` (and `openhorn.sendPrompt` in `html-ui`) is only for
  follow-ups that need new model content, and still only fills the composer.
  The mortgage example in `OPENUI_EXAMPLES` shows both side by side
  (`SegmentedControl($mode, ...)` + `byPrincipal ? ... : ...`, plus one
  `@ToAssistant` follow-up); `prompt.test.ts` keeps it that way.
- A control that promises a local operation must include the complete state
  and calculation logic in the same program. A mode switch keeps the current
  parameters and changes its results immediately; it cannot delegate a missing
  formula to a follow-up. If new model content is required, the label must say
  so. The canonical `lib/genui/mortgageExample.ts` program is shared by the
  generation prompt and actual Chat/Agent browser regression: both repayment
  modes include total repayment/interest, and declining payments identify the
  first/last payment and monthly decrease. Zero interest is exactly zero at a
  zero rate, rather than a floating-point subtraction that can display `-¥0`.
- `Button` classifies draft preparation from evaluated action semantics,
  including implicit actionless follow-ups, legacy configs and mixed plans.
  Keep its primary visible label concise: do not append composer-hint badges
  or separators. A hidden accessible description explains that the action
  prepares a draft without sending. Local Set/Reset and clipboard/link actions
  do not get that draft description. Never infer actions from label wording
  or change `@ToAssistant` / HTML proposals into automatic sends.
- Action semantics and visual priority are independent. Respect explicit
  variants and the user's requested hierarchy: an AI follow-up can be solid,
  outline or ghost. Check contrast, wrapping and keyboard focus in both themes.
  Do not impose a secondary-only style on every follow-up or add repetitive
  instructions below controls that already explain their task.
- In a self-contained calculator or explorer, keep related modes and numerical
  inputs together with results nearby. Choose the continuation's emphasis for
  that task and the user's preference, rather than a universal widget layout.
- Isolate GenUI heading rules from surrounding Markdown descendant selectors
  with a scoped selector such as `.block .title`. Verify computed spacing
  inside actual Chat and Agent bubbles; isolated component previews can hide
  cascade regressions.
- Updating generation instructions does not repair an existing program with
  missing business logic. Correct a specifically requested historical artifact
  explicitly, retaining its original revision and guarding against concurrent
  content changes. Do not ship per-user message IDs, source fingerprints or
  broad natural-language rewrites as renderer compatibility logic.
- Only user-editable values are `$variables`, with literal defaults; derived
  values are plain names (`periods = $years * 12`). OpenUI Lang 1.0 does
  **not** report `$x = <expression>`: `materializeValue` leaves the AST node
  (`{k: "BinOp" | "Comp" | ...}`, also nested inside array / object literals)
  in `ParseResult.stateDeclarations`, `meta.errors` stays empty, and the store
  is seeded with that node, so it renders as blank / `0` / `[object Object]`.
  The prompt rule alone did not stop gpt-5.4-nano from writing it, so complete
  blocks are repaired before rendering (`lib/genui/stateCheck.ts`):
  `computedStateNames(source)` inspects declaration expression ASTs using
  lang-core's public tokenizer/parser APIs, before materialization. Literal
  business objects such as `{k: "Ref", name: "one"}` remain literal data.
  `repairComputedState` rewrites each computed state declaration's references
  such `$name` to a plain name (`$months` -> `months`; `months_` if `months` is
  already a statement, another renamed name, or `true` / `false` / `null`).
  A computed `$x` that is also an input binding or a
  `@Set` target becomes a read-only derived value; it parses cleanly, so no
  notice is shown (accepted: before the repair it never rendered a value). The rewrite is
  token-aware like lang-core's lexer: string literals (both quotes, escapes) and
  `//` / `#` comments are left alone, and only whole identifiers match (`$r`
  never touches `$rate`). `GenUiBlock` applies it via `renderableProgram` only
  when not streaming (memoized on `code`); the stored message text is
  unchanged, user-input `$variables` keep their names so saved block state
  still applies. Parse errors and Renderer evaluation/component errors show
  `genui.partialErrors` with source fallback while retaining usable controls;
  correcting an input can recover without replacing the program. Unsupported syntax such
  as lambdas (`$f = (k) => ...`) materializes as `null` and is not repaired.
  Fixture: `components/chat/genui/fixtures/nanoMortgage.ts`; `prompt.test.ts`
  evaluates the repaired Stat values with lang-core's `evaluate` for both modes.
- All runtimes must carry per-run UI instructions. Codex uses its native
  developer-instructions transport; ACP, which has no standard system-prompt
  field, receives explicitly separated per-run instructions in its prompt.
  Cover both `agent.run` and the Codex `chat.stream` fallback: forwarding only
  the last user message drops the system prompt and conversation context.
- Claude Code OAuth channels (`sk-ant-oat…`) lost the
  whole system prompt until 2026-10-31: the billing marker was joined into the
  same `system` text as the prompt, and the API treats that block as billing
  metadata. The marker is now its own first block, and all OAuth rules (Bearer auth, model date-suffix strip, marker block) live only in `packages/adapters/src/anthropic-oauth.ts`, used by both the agent runtime and the chat adapter (chat mode used to get 429 without the marker).

## Security boundaries (keep intact)

- `html-ui` frames: `sandbox="allow-scripts"` only (never `allow-same-origin`),
  CSP meta first in the document (`lib/genui/sandbox.ts`: `default-src 'none'`,
  scripts only inline + temporary Blob modules + four CDNs, no other network).
  Blob URLs add no network destination; the bootstrap uses a module import
  promise to observe one inline module's own evaluation and revokes its URL
  on success or failure.
- The streaming preview frame runs no script (`sandbox=""`, script-free CSP).
- Bridge messages are accepted only from the block's own `contentWindow` and
  must pass `parseBridgeMessage`: `height` (clamped), `sendPrompt` (trimmed,
  capped, rate-limited), `openLink` (http(s) only).
- Follow-ups (`@ToAssistant`, `openhorn.sendPrompt`) are only **placed in the
  composer** (`genUiStore.requestComposerText`), appended to any draft. Never
  send on the model's behalf.
- `sendPrompt` and `openLink` are untrusted proposals, capped and rate-limited
  to one pending proposal of each kind. The parent displays the exact message
  or URL, and only a real click on that parent control applies it. Frame focus,
  frame-side `isTrusted`, nonces and claimed activation confer no authority.
  `height` only changes the clamped frame height.
- The initial `srcDoc` contains only the trusted bootstrap. Model markup is
  sent after that document's first load; scripts are recreated in order so
  classic CDN scripts finish before dependent inline code. Model code therefore
  cannot cancel the trusted initial load by immediately redirecting. Every
  subsequent frame load invalidates its bridge and removes the frame/proposals,
  showing `genui.frameNavigated`. A new program/theme creates a fresh session.
- Fragment initialization replays `DOMContentLoaded` and `load` after ordered
  scripts (and async completion for `load`). Inline module completion must
  resolve on success, syntax/import/evaluation errors and rejected top-level
  await (including non-Error rejection values), so a failed module cannot
  strand later scripts. Inline modules execute via one temporary Blob URL's
  `import()` promise, preserving their original source as an inert DOM node;
  a previous script's unrelated background error/rejection cannot complete
  the pending module. Do not infer module completion from global error events
  or a callback appended to the source. Report module failures separately and
  revoke each Blob URL on either outcome. Modern `nomodule` fallbacks are not
  awaited because the browser ignores them without events. These local
  readiness events never authorize host actions.
- Tauri / WKWebView: wry runs the main window's `on_navigation` for **every
  frame**, child frames included (`src-tauri/src/lib.rs`
  `main_window_allows_navigation`). It must admit `about:srcdoc`, or every
  `html-ui` frame stays blank in the desktop app while working in a browser.
  Anything else off-app is cancelled and never handed to the OS `open`: a frame
  can navigate itself without a click, and `open` would launch browsers or
  URL-scheme handlers for it. External link clicks in the app go through the
  shell plugin (`App.tsx` click handler) instead. In the desktop app a frame
  that navigates away is therefore cancelled before it loads; the
  subsequent-load unload above is the browser-side backstop. Compare parsed
  URL origins/hosts, reject userinfo, and allow only the configured debug dev
  origin, the platform's actual app origin, and exact `about:srcdoc`.
  Prefix tests for `localhost` admit attacker hosts and are forbidden.
- Accepted risk: `img-src https:` lets frame script send data the user typed
  into that frame to any host via image URLs. The frame can read no app data,
  and model-written pages need remote images, so this is accepted.

## State

Interaction state belongs to the raw UI program and message scope, independently
of React mounts and localStorage debounce timing. Keys include
`<messageId>[:<agentStepIndex>]:<blockStartOffset>:v2:<programFingerprint>`.
Replacing a program at the same offset cannot inherit its predecessor's state;
a canceled retry can reopen the previous revision's state.

`rememberBlockState` publishes a serialized snapshot synchronously on every
complete-block state update. Disk persistence remains debounced by 300 ms, with
cleanup flushing the newest snapshot rather than overwriting it with stale
component state. `migrateBlockStateScope` runs before chatStore publishes a
persisted replacement message ID; it migrates all Agent step keys and aliases
pending writes from the optimistic ID.

Keep the same Markdown renderer mounted when streaming ends or an Agent text
step stops being the last text step. Completed HTML frames can already contain
live DOM and script state; replacing a streaming wrapper with a static wrapper
destroys that state. Finishing must synchronously flush the final content, and
clearing for a retry must reset both the smoother target and displayed content.
Program and theme changes still intentionally create a new HTML sandbox.

Virtual message rows use `Message.renderKey ?? Message.id` for each member of a
round. `renderKey` preserves the first mounted identity across optimistic ID
replacement and server refreshes; keep it local to the frontend and never write
it to the API or database. The actual persisted ID continues to own GenUI state
scopes, so migrate those scopes before publishing the ID change. Server reloads
inherit only the local rendering identity while accepting server content.

Memory caches are separated by storage identity. Persistence is best effort,
bounded at 300 entries, 64 KiB per payload and 4 MiB total; sizes use encoded
bytes. Evict before writes and retry quota failures, including index writes.
Memory and disk evictions use independent budgets: a disk quota failure must
not delete another mounted block's unflushed memory snapshot.
Blocked/corrupt storage must not break mounted controls. State is local and is
not synced to the server.

## Runtime validation

Accept both `ParseResult.root` and `rootExpression`. Root sequences (including
`@Each`, arrays, aliases and conditional sequences) are wrapped in the library's
`Col` without rewriting literal keys/member access. A previous failed chunk
must not latch the final program into fallback: parse status and diagnostics
belong to the current program. Renderer `onError` is required in addition to
the outer React error boundary because OpenUI catches evaluation/component
errors internally.

Slider bounds and step changes normalize the actual bound value, not just its
display, so dependent calculations agree with the slider. Read the committed
native range's `valueAsNumber` for that normalization: separately calculating
`(max - min) / step` can overflow even when all inputs and the native result
are finite. Streaming controls never publish normalized values. Slider readouts
and `aria-valuetext` must preserve the selected precision (a `0.001` step cannot
be announced as `0` by the shared two-decimal display formatter).
One reactive binding owns one Slider domain: all its Slider views must use the
same effective `min`, `max` and `step`, regardless of their labels. Register
domains in layout effects and validate the complete committed tree before any
passive normalization. A mismatched domain uses the existing notice and source
fallback; do not let controls compete by alternately clamping one variable.
Common dynamic bounds must update together without comparing old and new
views midway through the commit. Stage synchronous Renderer state callbacks
until the resulting tree has committed and passed validation, preserving the
last valid memory/disk snapshot when a conditional view introduces a conflict.
Do not solve domain intersections with another floating-point algorithm or
replace this contract with an update-count threshold.
Numeric drafts retain the user's complete text until blur while publishing live
canonical state. A block-local `ControlEditContext` records each input publication
only through its committed effects: a Slider normalization of that publication
updates the draft's ownership value, preserving its text. The record expires
after the commit, so later Slider actions, resets and constraint changes still
replace stale drafts. Never preserve every focused draft indiscriminately or
wait until blur to publish numeric state. Test actual sequential typing in both
component orders; one-event `fill` alone misses characters appended to a draft
that normalization has rewritten in the middle of typing.
`@ToAssistant` keeps
explicit second-argument context in the visible composer draft; message plus
context fit the shared 2,000-character limit and are never automatically sent.
Preserve both in full when their combined length fits; allocate truncation
budgets only when the combined draft exceeds that limit.

## Executable lifecycle and transport contract

### 1. Scope / Trigger

These rules apply when streaming Markdown becomes executable UI, when React
remounts a block, when an optimistic message ID is persisted, and when an
external agent runtime receives the per-run system prompt. Native integration
checks also require the isolated QA environment below.

### 2. Signatures

```ts
blockStateKey(scope: string, offset: number, program?: string): string
loadBlockState(key: string, storage?: BlockStateStorage | null): Record<string, unknown> | undefined
rememberBlockState(key: string, state: Record<string, unknown>, storage?: BlockStateStorage | null): void
saveBlockState(key: string, state: Record<string, unknown>, storage?: BlockStateStorage | null): void
migrateBlockStateScope(fromScope: string, toScope: string, storage?: BlockStateStorage | null): void
endsInsideOpenFence(content: string): boolean
buildSandboxDocument(theme: ThemeSnapshot): string
```

### 3. Contracts

- Markdown passes the raw complete `codeString` as the key's program identity;
  disabled streaming inputs use a stable placeholder revision.
- Publish memory before scheduling disk writes, and migrate message scope
  before publishing its new ID to subscribers. Old-ID cleanup writes resolve
  to the migrated scope and cannot replace a newer snapshot.
- The parent sends `{type: "openhorn-genui", action: "render", html}` only
  after trusted bootstrap load. Frame proposals use `sendPrompt/text` or
  `openLink/url`, never an authorization flag. Source-window validation and
  payload validation remain required, even though neither authorizes an action.
- `agent.run.systemPrompt` is optional per-run input. Each runtime must
  actually forward it through its native instruction field or clearly
  separated context; no DB field or persistent session setting is added.
- Generation failure must preserve and persist the exact partial Markdown
  using the prepared assistant ID. Show failure separately; never replace or
  append an error inside a model-written code fence. Ignore chunks after a
  terminal event. Terminal SSE errors can carry `messageId` and `model`; migrate
  the local reply to that ID before offering retry, including newly created
  edited-tail replies. An empty failed retry restores the preceding reply;
  editing a question keeps only its new reply, which can be empty.
- A stopped turn's save may finish after the next send begins. Message-specific
  persistence still belongs to the old turn; loading/streaming/error state and
  cleanup belong to the current turn. Never let an old save or finalizer end
  the newer generation or reload a snapshot over its optimistic messages.
  The same ownership check applies to delayed retry/edit responses and SSE
  terminal events. Stop restores a zero-output retry synchronously. If Agent
  preparation has not reached the run hook, Stop persists the question or edit
  independently and awaits that one-shot save before enabling the next send;
  the old preparation must never start a run that cancels the new one.
- Foreground turn ownership outlives the chat page. `lib/foregroundTurn.ts`
  retains Chat and caller preparation cancellation, and the Agent hook's shared
  lifecycle retains its controller, busy state, pending approval, session and
  checkpoint state. A settings/task navigation or explicit remount must retain
  Stop, partial output, pending approvals and the running bubble's appearance.
  Every send, historical Retry and edit submission (including Enter) checks
  the live controllers and `streamingMessageId` synchronously. Button disabling
  supplements this admission check; it cannot replace it.
- `streamingMessageId` owns composer streaming state and follows optimistic-ID
  replacement, edited-tail terminal IDs and Agent reconciliation in both the
  current view and cache. A background message's completion/error updates its
  own message without releasing another reply or replacing the foreground error.
  Conversation-list refresh after Agent completion uses `{background: true}`;
  this read must not reset a new turn's loading flag or erase a failure.
- Agent success/error terminal callbacks converge on one finalization path.
  The transport calls `onDone` before the projected `done` event; both orders
  must complete the message and persist once. Keep the controller until that
  save settles and the message IDs reconcile, so Retry cannot start against
  an ID that the previous save is still renaming. Stop shares one cancellation
  promise, persists once and releases ownership after its save. Late events,
  approvals and session IDs from a stopped or completed run are ignored.
  A sidecar readiness failure after caller preparation uses this same failure
  finalizer: persist a fresh/edited question, restore a zero-output retry's
  previous answer, display the error separately and release the owner. An early
  return that only records a hook error leaves an unpersisted, stuck partial turn.
- Each Agent run forwards the root returned by its own successful
  `ensureWorkspace` call as `agent.run.workspaceRoot`. A failed default or project
  directory resolution refuses the run and persists the failed question;
  neither an earlier store value nor the connection's mutable current directory
  may substitute for that result. The sidecar validates and captures this root
  for the run, so an older workspace-setting RPC cannot redirect a newer turn.
- Fence completeness comes from Markdown grammar independently of transport
  state. Stop, error, history reload and remount never make an unclosed HTML or
  OpenUI fence executable. A preceding closed block remains interactive.
- ACP is Agent-only. Both composers block Chat submission before creating or
  preparing a round, preserve the draft and show a mode explanation. Historical
  Chat retry/edit must also reject a currently selected ACP channel before
  clearing the reply. Memoized historical bubbles retain callbacks, so route
  capabilities from the live channel/model store at invocation. Agent access
  and permission settings remain separate.

#### Native QA environment

- Keep the normal backend/data on port **3002**. Build the separate QA app
  with `VITE_API_BASE=http://127.0.0.1:3302`, a task-local `frontendDist`,
  `productName: "OpenHorn QA"` and `identifier: "com.openhorn.nativeqa"` in
  its Tauri merge config. Preserve the normal `.app` unchanged. The distinct
  bundle ID isolates WKWebView storage; it does not sandbox shared native
  filesystem settings or the sidecar diagnostic endpoint.
- Inject the persistent visible badge
  `测试环境 · OpenHorn QA · 独立测试数据` into QA built HTML before bundling.
  Keep it outside the React root with fixed contrasting colors and
  `pointer-events: none`, so navigation/themes retain it without intercepting
  controls. A different icon or bundle name alone does not distinguish an
  otherwise identical app showing an empty test history.
- The task-local seeder signature is
  `node native-seed-fixtures.mjs --base http://127.0.0.1:3302`. Require an
  explicit HTTP loopback origin on port 3302; reject 3002 and other origins
  **before any fetch/write**. Use deterministic fixtures/local fake providers,
  never real model credentials or model calls, for native regressions.

### 4. Validation & Error Matrix

| Input / event | Required behavior |
|---|---|
| Root expression or root sequence | Render supported UI |
| Incomplete chunk followed by valid final code | Retry parsing and recover |
| Evaluation/component failure | Notice + source fallback; keep usable controls |
| Literal `{k: "Ref"}` in state | Preserve its name and value |
| Changed program with same message/offset | Use its own defaults/snapshot |
| Remount before 300 ms flush / persisted ID replacement | Restore newest memory snapshot |
| Storage quota / blocked access / corrupt data | Bounded eviction/retry or memory-only continuity |
| Unclosed quoted/list fence | Keep preview non-executable and controls disabled |
| Stop/error while HTML/OpenUI fence is unclosed | Keep preview inert through reload/remount; preceding closed blocks still work |
| Chat provider failure after partial output | Persist exact partial and ID; show a separate error with usable retry |
| Old stopped save settles during next send | Preserve the newer turn's loading/streaming/error state |
| ACP channel in Chat mode | Block Send/Enter and reruns before writes; retain draft and Agent support |
| Frame focus / forged activation / unsolicited proposal | No composer edits or links opened |
| Real parent click on displayed pending proposal | Consume that exact proposal once |
| Subsequent frame document load | Revoke bridge, remove frame and pending proposals |
| `localhost@attacker` or `localhost.attacker` navigation | Reject |
| Seeder base is normal port 3002 or a non-QA origin | Reject before network access |
| QA bundle lacks badge, distinct ID or embedded 3302 base | Do not launch as a QA app; rebuild the isolated package |

### 5. Good / Base / Bad Cases

- Good: edit a closed block while a later paragraph streams, then reconcile
  the message ID; the edited value survives both operations.
- Base: UI is disabled at send time; no UI instructions are appended, and
  existing programs in history still render.
- Bad: use frame focus as evidence of a user gesture, or use an old stored
  value for a regenerated program merely because its block offset matches.

### 6. Tests Required

- `blockState.test.ts`: independent revisions/storage objects, immediate
  snapshots, delayed cleanup, full-scope migration, quota and corrupt storage.
- `fence.test.ts`: CommonMark/GFM container syntax and non-fence HTML contexts.
- `prompt.test.ts`: source-based computed-state repair, literal AST-shaped data,
  root sequence wrapping and bounded explicit follow-up context.
- `mortgageExample.test.ts` compares both local repayment modes with independent
  balance iteration, including zero rates and short/long terms.
  `actionSemantics.test.ts` checks evaluated plans against the runtime's actual
  follow-up projection. `genui-local-actions.browser.mjs` exercises the shared
  canonical program through real Chat/Agent message trees, preserving input
  values and modes across remount/reload while local switching leaves the
  composer request unchanged. Include it in `test:genui:browser`.
- Actual-component browser regressions under `apps/desktop/scripts/`: runtime
  diagnostics/recovery, native slider values and dependent output, Markdown
  fence completion, stream/theme/ID remounts, host-confirmed proposals, script
  order and redirects. Helper-only tests cannot prove lifecycle/gesture behavior.
  Network-mocked sandbox tests explicitly wait for frame instrumentation before
  releasing their first request: a new opaque frame can issue requests before
  Playwright attaches its interception. Use a fixture-only readiness gate,
  not arbitrary sleeps or production authorization checks.
- Rust navigation tests: legitimate app/debug origins and exact `about:srcdoc`,
  rejected userinfo, wrong ports/schemes and host lookalikes.
- Fake Codex/ACP transports: inspect the actual submitted instruction/prompt
  payload with UI enabled and omitted; do not call a live model for this check.
- Native QA packaging: verify `Info.plist` ID, the actual embedded frontend's
  3302 base and visible badge, and unchanged normal-app hashes. Verify the
  seeder rejects 3002 before fetch. Native checks must exercise the real
  WKWebView; static history fixtures cannot prove streaming/retry transitions.

### 7. Wrong vs Correct

```ts
// Wrong: mount timing and disk debounce own the latest state.
setTimeout(() => saveBlockState(key, state), 300);
// Correct: publish now, persist later; ID reconciliation aliases both.
rememberBlockState(key, state);
setTimeout(() => saveBlockState(key, state), 300);

// Wrong: a generated frame can arrange its own focus.
if (document.activeElement === iframe) requestComposerText(message.text);
// Correct: display a bounded proposal, apply it from a real host button click.
```

```sh
# Wrong: seed test conversations into the normal user backend (must fail).
node native-seed-fixtures.mjs --base http://127.0.0.1:3002
# Correct: use the explicit disposable QA origin and visibly marked QA app.
node native-seed-fixtures.mjs --base http://127.0.0.1:3302
```

## Control and numeric contracts

- The registry contains 22 components and one custom `CopyToClipboard` action.
  `scripts/genui-controls.browser.mjs` exercises the complete registry through
  the production Chat and Agent message trees. Keep it in `test:genui:browser`.
  Its fixture uses an isolated store and local server; it never sends model
  requests or touches the normal application's conversations or clipboard.
- A numeric `Input` stores a finite number, or `""` when cleared. Its incomplete
  text draft (such as `"1."` or `"-"`) belongs to the value it last published.
  Changes from another bound control or an action invalidate that draft;
  blur restores the canonical value. Never publish `null` through the reactive
  setter: the upstream evaluator treats a null `$value` as a missing override.
- Dynamic `Select` and `SegmentedControl` options preserve a selected value
  while it remains present, including reorder and label changes. Removing a
  nonempty selection clears the binding to `""`; it does not select an arbitrary
  replacement. Empty lists and explicit empty-valued options are supported.
  Normalization waits until streaming finishes. Segmented choices use a named
  semantic group without changing the accessible name of the first button.
- `Progress` exposes its label and finite clamped value with progressbar
  semantics. A missing, nonpositive or nonfinite maximum uses 100. Compute
  `aria-valuenow` directly from the clamped value, not from `ratio * max`,
  which can underflow for tiny values.
- Chart extents scan values without spreading a series into function arguments.
  Finite endpoints may overflow their difference or underflow a tick step:
  retain finite endpoint/zero ticks and scale coordinates before subtraction.
  Pie weights scale by their largest positive value before summing so large
  finite values retain valid shares. Do not add arbitrary series-length caps.
- The browser matrix must cover external set/reset, incomplete number drafts,
  cleared shared bindings and remounts, dynamic choices, keyboard controls,
  disabled streaming, stop/completion, persisted message IDs and reloads,
  all action categories, chart variants and finite numeric extremes. The dense
  chart regression evaluates 200,000 real values in Chromium without attaching
  a synthetic 200,000-element DOM; Bun alone does not reproduce its argument
  limit.

## Bundle

`GenUiBlock`, the library and the prompt builder load through
`components/chat/genui/lazy.tsx`. Do not import them statically from always-loaded
modules; the OpenUI runtime plus the lucide namespace is ~950 KB.

The block loader caches one dynamic import and publishes its resolved component
through ordinary React state. React 19's first Suspense commit added a reproduced
~300 ms delay even after that module was already evaluated; do not reintroduce
`React.lazy` for this path without measuring production first-use latency. Keep
readable source while the chunk loads or fails, ignore completion after a
consumer unmounts, and reuse the cached component type after loading so controls
retain their identity. Plain Markdown must not request the OpenUI chunk. The
production split-chunk regression is `scripts/genui-loading.browser.mjs`.

## Common mistakes

- Using lucide's `icons` map for model-written names: it lacks aliases
  (`check-circle`). Use `iconFor`.
- Giving `.frameWrap` a border with `border-box` sizing: the frame ends up 2px
  shorter than the measured content and scrolls.
- `:global(.dark)` in the CSS module: biome rejects it; use hues that read on
  both themes or theme tokens.
- Importing `@openuidev/react-lang` before `lazy.tsx` sets
  `Symbol.for("openui.devtools.autoMount")`: in `NODE_ENV=development` the
  library then mounts its OpenUI Inspect overlay (with a hosted-service upsell)
  over the app.
- Printing model values with `String(...)`: a mis-declared derived value
  (`$x = expr`) arrives as an object and shows `[object Object]`. Display
  text goes through `numberText`, which renders non-scalars as empty.
