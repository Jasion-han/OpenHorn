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
