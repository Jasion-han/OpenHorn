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
- The section is built from the library (`buildGenUiSystemPrompt`) and appended
  only when the composer's "Interactive" chip is on, via `lib/genui/promptMerge.ts`
  at every send site in `DesktopChatArea` (agent send / retry / edit, chat send).
  Chat-mode retry / edit run the LLM call on the server, so the section is sent
  as `appendSystemPrompt` in the `/messages/:id/regenerate` and `/messages/:id/edit`
  body (server: `services/appendSystemPrompt.ts`, 32,000-char cap → 400). The
  server appends it to that one call's system prompt and never persists it.
  Off means the request is byte-for-byte what it was before (the field is omitted).
- Local vs. model interactions (task `10-31-genui-local-actions`): anything
  computable from data the block already has (mode / view switch, filter,
  sort, details) is a `$variable` + `@Set` / an input + ternary inside the
  block. `@ToAssistant` (and `openhorn.sendPrompt` in `html-ui`) is only for
  follow-ups that need new model content, and still only fills the composer.
  The mortgage example in `OPENUI_EXAMPLES` shows both side by side
  (`SegmentedControl($mode, ...)` + `byPrincipal ? ... : ...`, plus one
  `@ToAssistant` follow-up); `prompt.test.ts` keeps it that way.
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
  scripts only inline + four CDNs, no other network).
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
  resolve on success, import errors, evaluation errors and rejected top-level
  await, so a failed module cannot strand later scripts. Modern `nomodule`
  fallbacks are not awaited because the browser ignores them without events.
  These local readiness events never authorize host actions.
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
display, so dependent calculations agree with the slider. `@ToAssistant` keeps
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

## Bundle

`GenUiBlock`, the library and the prompt builder load through
`components/chat/genui/lazy.tsx`. Do not import them statically from always-loaded
modules; the OpenUI runtime plus the lucide namespace is ~850 KB.

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
