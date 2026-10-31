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
(`lib/genui/fence.ts`). Only the block the text currently ends in is
"streaming" (`endsInsideOpenFence`); earlier blocks are interactive as soon as
their fence closes.

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
  `computedStateNames` finds those entries, `repairComputedState` rewrites each
  such `$name` to a plain name (`$months` -> `months`; `months_` if `months` is
  already a statement, another renamed name, or `true` / `false` / `null`) and
  re-parses, up to 3 passes. A computed `$x` that is also an input binding or a
  `@Set` target becomes a read-only derived value; it parses cleanly, so no
  notice is shown (accepted: before the repair it never rendered a value). The rewrite is
  token-aware like lang-core's lexer: string literals (both quotes, escapes) and
  `//` / `#` comments are left alone, and only whole identifiers match (`$r`
  never touches `$rate`). `GenUiBlock` applies it via `renderableProgram` only
  when not streaming (memoized on `code`); the stored message text is
  unchanged, user-input `$variables` keep their names so saved block state
  still applies, and `genui.partialErrors` shows only when the repaired program
  still has `meta.errors` or unrepaired computed state. Unsupported syntax such
  as lambdas (`$f = (k) => ...`) materializes as `null` and is not repaired.
  Fixture: `components/chat/genui/fixtures/nanoMortgage.ts`; `prompt.test.ts`
  evaluates the repaired Stat values with lang-core's `evaluate` (resolved
  through react-lang, which depends on it) for both modes.
- Channels that drop the system prompt cannot use components: Codex CLI and
  ACP ignore `systemPrompt`. The model then invents `openui-lang` syntax, which
  only renders as the plain-code fallback. Verify a channel by asking it to
  quote a component signature from its system prompt.
- Claude Code OAuth channels (`sk-ant-oat…`, sidecar `runClaudeAgent`) lost the
  whole system prompt until 2026-10-31: the billing marker was joined into the
  same `system` text as the prompt, and the API treats that block as billing
  metadata. `buildClaudeSystem` now sends the marker as its own first block.

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
- `sendPrompt` and `openLink` from a frame are accepted only while that frame
  is the parent's `document.activeElement` (`acceptsUserAction` in
  `lib/genui/sandbox.ts`), i.e. the user clicked into it. A cross-origin frame
  cannot focus itself without user activation, so a script calling the bridge
  on load is ignored. `height` is unconditional. Per-frame rate limits stay.
- A running frame that navigates itself away (`location = "https://..."`; the
  meta CSP does not apply to the new page) is unloaded: `HtmlUiBlock` counts
  `load` events per `runDoc` (the srcdoc load is the first), and on a second
  one replaces the iframe with a one-line notice (`genui.frameNavigated`). A
  new `runDoc` (theme switch) restarts the count.
- Tauri / WKWebView: wry runs the main window's `on_navigation` for **every
  frame**, child frames included (`src-tauri/src/lib.rs`
  `main_window_allows_navigation`). It must admit `about:srcdoc`, or every
  `html-ui` frame stays blank in the desktop app while working in a browser.
  Anything else off-app is cancelled and never handed to the OS `open`: a frame
  can navigate itself without a click, and `open` would launch browsers or
  URL-scheme handlers for it. External link clicks in the app go through the
  shell plugin (`App.tsx` click handler) instead. In the desktop app a frame
  that navigates away is therefore cancelled before it loads; the
  second-`load` unload above is the browser-side backstop.
- Accepted risk: `img-src https:` lets frame script send data the user typed
  into that frame to any host via image URLs. The frame can read no app data,
  and model-written pages need remote images, so this is accepted.

## State

Interaction state of `openui-lang` blocks is saved in localStorage under
`<messageId>[:<agentStepIndex>]:<blockStartOffset>` (`lib/genui/blockState.ts`,
capped at 300 entries / 64 KB each). Not synced to the server.

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
