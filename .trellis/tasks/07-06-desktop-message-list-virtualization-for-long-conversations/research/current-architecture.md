# Research: Current message-list rendering / scrolling / streaming architecture (desktop)

- **Query**: Document the existing message-list rendering, scrolling, and streaming architecture in the OpenHorn desktop app so a virtualization plan can preserve all current behavior.
- **Scope**: internal
- **Date**: 2026-07-06

## Files Found

| File Path | Description |
|---|---|
| `apps/desktop/src/components/chat/DesktopChatArea.tsx` | The whole chat view: message list render, scroll management, streaming orchestration, composer wiring, slash panel, edit/retry/delete. ~2389 lines. |
| `apps/desktop/src/components/chat/DesktopMarkdownMessage.tsx` | Static markdown renderer + `CodeBlock` (deferred syntax highlighting via `requestIdleCallback`), copy buttons, link handling. |
| `apps/desktop/src/components/chat/DesktopStreamingMarkdownMessage.tsx` | Streaming wrapper that feeds tokens through `textStreamSmoother`, then renders through `DesktopMarkdownMessage`. |
| `apps/desktop/src/lib/textStreamSmoother.ts` | Char-by-char smoothing state machine used only while streaming. |
| `apps/desktop/src/stores/chatStore.ts` | Zustand store: `messages` array, delta append, agentRun mutation, per-conversation LRU cache. |
| `apps/desktop/src/hooks/useSidecarAgentRun.ts` | Agent-mode run driver; pushes deltas/agent events into the store via `applyStreamEvent`. |
| `apps/desktop/src/components/chat/DesktopMessageAttachments.tsx` | Renders user-message image/file attachments (variable height). |
| `apps/desktop/src/types/chat.ts` | `Message` type incl. `streamTail`, `streamPulseKey` (lines 211-212). |

---

## 1. Message list rendering

### The scroll container and list DOM (the render tree)
`DesktopChatArea.tsx:2246-2269`:

- Outer flex column: `div.flex h-full min-h-0 ... flex-col overflow-x-hidden` (2247).
- Header block (2248-2250).
- **Scroll viewport** (2252-2256): `div ref={viewportRef}` with classes `flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden overflow-y-auto scrollbar-thin`, horizontal padding via inline style. **This is the single scroll container** (`overflow-y-auto`).
- Inside it: `div.flex min-w-0 w-full flex-col` (2257) wrapping `div.mt-auto flex min-w-0 flex-col gap-2 pb-2` (2258). The `mt-auto` pins content to the bottom when short (messages hug the composer).
- The `.map` render (2259-2266): iterates `groupedMessages`; each group is a `div key={group.key} className="flex min-w-0 flex-col gap-2"` containing up to two rows rendered by `renderMessageRow`.

There is **no windowing / virtualization today** — every message row is mounted.

### `groupMessagesByRound` / `groupedMessages`
- `groupMessagesByRound(messages)` — `DesktopChatArea.tsx:746-779`. Walks the flat `messages` array. When a `user` message is immediately followed by an `assistant` message **with the same `mode`**, both are packed into one group with `key = "${user.id}:${assistant.id}"` and both entries carry their original array `index`. Otherwise a lone user or lone assistant message becomes its own group keyed by `msg.id`.
- Types: `GroupedMessageEntry = { msg, index }` (735-738); `MessageRoundGroup = { key, user?, assistant? }` (740-744).
- Memoized: `const groupedMessages = useMemo(() => groupMessagesByRound(messages), [messages])` — `DesktopChatArea.tsx:1076-1079`. Rebuilds only when the `messages` reference changes (which is every streamed token, see §3).

### `renderMessageRow` — `DesktopChatArea.tsx:2158-2244`
Each row is a `div` whose `ref` callback registers/unregisters the node in `messageAnchorRefs` **only for `role === "user"`** (2160-2167) — assistant rows are never anchored. Row alignment: assistant `items-start`, user `items-end` (2168-2171).

Inside, an IIFE (2173-2207) derives streaming state per message:
- `isInProgress` = `message.agentRun?.status === "partial" | "running"` (globally persisted, survives conversation switch) — 2180-2181.
- `isLocallyStreaming` = `isStreaming && streamingAssistantId && message.id === streamingAssistantId` — 2185-2187.
- `isMessageStreaming = isInProgress || isLocallyStreaming` — 2188.

Then renders `<MessageBubble>` (2191-2205) with `canEdit`/`canRetry`/`canDelete` computed inline (note `canEdit` calls `getEditableMessageRound(message.id)` **every render**), plus `assistantWidth="92%"`, `userMaxWidth="72%"`, `knownCommands`.

Below the bubble, when the row is a user message being edited (`editingMessageId === message.id`), an inline `<Textarea>` editor is rendered (2209-2242).

### `MessageBubble` and its `memo` comparison
- Implementation: `MessageBubbleImpl` — `DesktopChatArea.tsx:781-955`.
- Memo wrapper: `MessageBubble = memo(MessageBubbleImpl, ...)` — `DesktopChatArea.tsx:962-973`. Custom comparator returns true (skip re-render) when ALL of: `prev.message === next.message` (reference equality — the store returns the SAME object for unchanged rows via `.map`), `isStreaming`, `canEdit`, `canRetry`, `canDelete`, `assistantWidth`, `userMaxWidth`, `knownCommands` are equal. Callbacks (`onEdit`/`onRetry`/`onDelete`) are intentionally NOT compared. The comment at 957-961 states the design intent: during streaming only the streaming bubble re-renders; all others bail out via reference check.

### What a bubble contains (variable content)
`MessageBubbleImpl` (781-955):
- Assistant vs user styling (831-852); assistant gets a mode badge ("Agent"/"Chat") 853-858.
- User attachments: `<DesktopMessageAttachments>` 860-862.
- `processPanel`: agent run panel (`<AgentRunPanel>` or a "Thinking" meta line) 818-829, 864.
- Assistant text region 866-896: `LiveStatusBadge` (868-872), then either `<DesktopStreamingMarkdownMessage>` (while streaming, non-flat-agent) or `<DesktopMarkdownMessage>` (settled) 881-893, then `<DesktopCitationList>` 895.
- User text region 897-932: renders plain text with an inline slash-command chip when the content contains a known `/skill` or `/mcp` token (`findKnownSlashToken`), otherwise raw content.
- `MessageActionBar` (942-952 → impl 662-733): copy / edit / retry / delete icon buttons, revealed on `group-hover`.

---

## 2. Scroll management

### Refs involved
- `viewportRef` (`DesktopChatArea.tsx:1006`) — the scroll container element (2253).
- `pendingScrollTargetRef` (1009-1011) — a `{ type: "bottom" } | { type: "message"; id } | null` describing the next scroll action to perform in a layout effect.
- `messageAnchorRefs` (1012) — `Map<string, HTMLDivElement>` of **user-message** row DOM nodes, populated by the `renderMessageRow` ref callback (2160-2167).
- `inputRef` (1007) — composer textarea, focused via `queueMicrotask` in several places.

### Scroll-on-conversation-switch
`DesktopChatArea.tsx:1081-1084`: `useEffect` on `[currentConversation?.id]` sets `pendingScrollTargetRef.current = { type: "bottom" }` and focuses the input. So switching conversations always queues a jump to bottom. **There is no saved/restored per-conversation scroll position** — every switch snaps to the bottom.

### The core scroll layout effect
`DesktopChatArea.tsx:1086-1116` — `useLayoutEffect` with deps `[messages, currentConversation?.id, editingMessageId, isStreaming]`:
- Reads `viewportRef` + `pendingScrollTargetRef`; bails if either is missing.
- `type === "bottom"`: `viewportEl.scrollTop = viewportEl.scrollHeight`, then clears the pending target (1091-1095).
- `type === "message"`: looks up the anchor node in `messageAnchorRefs`; if missing, returns WITHOUT clearing (so it retries on the next effect run) (1097-1098). Computes `desiredTop` from the anchor's `getBoundingClientRect().top` relative to the viewport plus current `scrollTop` (1100-1103) and sets `scrollTop = desiredTop` — this scrolls so the target **user message is pinned to the top of the viewport**. It then re-measures `distanceFromTop`; only clears the pending target when the anchor is within 4px of the top OR when not streaming (1107-1115). This means during streaming the effect keeps re-pinning the just-sent user message to the top as the assistant answer grows (a "scroll to my question" behavior, not "stick to bottom").

### "Scroll on new message" behavior
On send (`handleSend`), after adding the user+assistant draft messages, `pendingScrollTargetRef.current = { type: "message", id: userMessageId }` — `DesktopChatArea.tsx:1591`. So a fresh send scrolls the new user message to the top and holds it there while the answer streams (via the re-pin logic above). Retry sets the same target to the preceding user message (1815); edit sets it to the edited user message (1972).

### Important: NO classic "stick to bottom during stream"
There is no bottom-following auto-scroll during streaming. The only auto-scroll behaviors are:
1. On conversation switch → jump to absolute bottom (one-shot).
2. On send/retry/edit → pin the relevant user message to the top and re-pin while streaming.
There is no scroll-position preservation, no "user scrolled up, stop auto-scrolling" guard, and no scroll-to-bottom button.

### Other scroll-adjacent state resets on conversation switch
`useEffect [currentConversation?.id]` also: resets `streamingAssistantId` + clears sidecar error (1118-1121), clears pending attachments (1123-1125), revokes preview object URLs on unmount/switch (1176-1189).

---

## 3. Streaming updates

### How streamed tokens mutate `messages`
Two producers, both funnel into the store:
- **Chat mode (SSE / sidecar chatStream)**: `consumeStreamingResponse` (1235-1257) → on `delta` calls `useChatStore.getState().appendMessageDelta(messageId, chunk)` (1242). Direct sidecar chatStream path calls the same at 1727.
- **Agent mode (sidecar run)**: `useSidecarAgentRun.ts` calls `applyStreamEvent(assistantMessageId, { type: "delta", ... })` for `text`/`final_text` events (388-399) and `{ type: "agent_event", ... }` for tool steps (406-411). `applyStreamEvent` (`chatStore.ts:578-643`) routes `delta` → `appendMessageDelta`, `agent_event` → merges into `message.agentRun` via `applyAgentEventToRun`.

### `appendMessageDelta` — `chatStore.ts:697-720`
If the message is in the live `messages` array: `set` maps over `messages`, and for the target message produces a NEW object with `content: content+delta`, `streamTail: getRollingTail(content+delta)` (18-char rolling window, defined 48-53), and `streamPulseKey: (prev ?? 0) + 1`. **Every other message keeps its exact same object reference** (the `.map` returns `message` unchanged) — this is what makes `MessageBubble`'s reference-equality memo bail out for non-streaming rows. If the message is NOT in the live array (user switched conversations mid-stream), it is patched in the LRU `messageCache` instead (713-718, `updateCachedMessage` 232-243), without `streamTail`/`streamPulseKey`.

Because `set` replaces the `messages` array reference on every token, `groupedMessages` is recomputed and the whole `.map` re-runs each token — but only the streaming bubble actually re-renders thanks to the memo.

### Streaming bubble render path
In `MessageBubbleImpl` (881-893): when `hasAssistantText && isMessageStreaming && !isFlatAgentAssistant`, it renders `<DesktopStreamingMarkdownMessage content={displayContent} tailLength={streamTailLength} pulseKey={message.streamPulseKey ?? 0} />`. `streamTailLength` = `message.streamTail.length` (815-816). Note: **agent-mode assistants (`isFlatAgentAssistant`) do NOT use the streaming smoother** — they render `DesktopMarkdownMessage` directly (settled path) even while streaming, plus a "Working" meta line (934-940).

### `DesktopStreamingMarkdownMessage` + `textStreamSmoother`
`DesktopStreamingMarkdownMessage.tsx`:
- Holds local `renderedContent` state; creates one `TextStreamSmoother` per mount (`useLayoutEffect` 18-31), cancelled on unmount.
- On each `content`/`pulseKey` change (33-68): diffs incoming `content` against `targetContentRef`. If `content` is a pure suffix-extension of the current target, pushes only the delta to the smoother (54-59). If it diverged (retry/edit reset), `smoother.cancel({flush:true})` and sets rendered content directly (62-65). Empty content cancels + clears (42-47).
- Renders `<DesktopMarkdownMessage content={renderedContent} />` (70).

`textStreamSmoother.ts` — a `setTimeout`-driven pump that reveals a few graphemes per tick (CJK-aware via `Intl.Segmenter`, ASCII-word aware). It has a "passthrough" mode auto-detected when chunks arrive fast/small (306-332), variable tick speeds (`tickIntervalMs` 14ms normal / 10ms fast / 8ms finish), and `firstBurst`/`fast`/`finish` phases. The key effect for virtualization: **the visible assistant text grows continuously and asynchronously on its own timer, independent of token arrival**, so the streaming bubble's height changes on nearly every animation frame during a response.

### How streaming interacts with auto-scroll
The scroll layout effect (1086-1116) depends on `messages` and `isStreaming`. During streaming, each token → new `messages` ref → effect re-runs → re-pins the target user message to the top (the pending target is not cleared while `isStreaming` unless the anchor is already within 4px). The smoother's async growth does NOT itself trigger the scroll effect (it only updates `DesktopStreamingMarkdownMessage`'s local state); scroll re-runs are driven by store `messages` updates and `isStreaming` transitions.

### Stream lifecycle end
On `done`/`error` the store flips `isStreaming` false (`completeStreamingMessage` 645-647, `failStreamingMessage` 649-682). The component often then calls `loadMessages` + `loadConversations` (e.g. 1751, 1916, 2074) which REPLACES the entire `messages` array with fresh DB rows (`loadMessages` 476-485 → `set({ messages })`) — meaning all message object references change and every bubble re-renders once after a stream finishes.

---

## 4. Variable-height content (why heights are unpredictable)

1. **Markdown body** — `DesktopMarkdownMessage` renders arbitrary GFM markdown (`remarkGfm`, `remarkBreaks`), including headings, lists, tables, blockquotes, images (`a`/`img` custom renderers 292-329). Height depends fully on content + viewport width.
2. **Code blocks with deferred highlighting** — `CodeBlock` (`DesktopMarkdownMessage.tsx:173-256`):
   - Small blocks (`shouldHighlightEagerly`: `<=12` lines AND `<=2000` chars, 96-101) highlight synchronously on first frame.
   - Large blocks render a plain-text placeholder first, then schedule Prism tokenization via `scheduleIdle` (`requestIdleCallback` with 200ms timeout fallback, 116-130) inside `startTransition` (193-200). The placeholder is carefully sized to match the highlighted output (line-number gutter width, line-height 1.5) to avoid layout jump — but the switch still happens **asynchronously after mount**, so a code block's final height may settle a frame or two late. Horizontal scroll container (`styles.codeScroll`, `wrapLongLines={false}`) — no wrapping, so height is line-count driven.
   - `CodeBlock` is itself `memo`'d on `codeString/className/language/isDark` (258-265).
3. **Tool / agent run panels** — `AgentRunPanel` (`DesktopChatArea.tsx:362-591`): a `<details>` element that is **auto-open while running/partial** (505) and collapsible otherwise; grows with the number of steps. Each tool step uses `InlineClampStep` (193-360) which **measures with `ResizeObserver` + a binary search over an offscreen clone in `useLayoutEffect`** (212-301) to clamp to 3 lines with a More/Less toggle — expanding/collapsing changes height, and the measurement itself runs after layout. Theme changes / width changes re-run the clamp.
4. **Attachments** — `DesktopMessageAttachments` renders image previews (single-image vs grid) and file chips; image intrinsic sizes vary and load asynchronously (`DesktopMessageAttachments.tsx`, image src via object URLs or backend URLs).
5. **Live status badge / citations** — `LiveStatusBadge` (140-181) and `DesktopCitationList` add conditional height.
6. **Streaming growth** — as described in §3, the streaming smoother grows the visible text continuously.
7. **Inline edit textarea** — a 3-row `<Textarea>` appears under a user message while editing (2209-2242), changing that row's height.
8. **Bubble widths** — assistant `92%`, user `max 72%`; content wraps with `overflowWrap:anywhere` / `wordBreak:break-word`, so height is width-dependent (relevant if a virtualizer needs to measure/estimate).

**Implication for virtualization:** row heights are not knowable ahead of time, settle asynchronously (idle-highlight, ResizeObserver clamp, async image load, streaming growth), and depend on container width. Any virtualizer must support dynamic measurement and re-measure on these async settles.

---

## 5. Things virtualization could break

- **User-message scroll anchors** — `messageAnchorRefs` (1012) only holds mounted user rows. The scroll effect (1097-1105) needs the target user node in the DOM to compute `desiredTop`. If a virtualizer unmounts off-screen rows, the "scroll my question to the top" behavior (send/retry/edit) breaks unless the anchor is force-mounted or the target height is otherwise resolvable. Note the effect already tolerates a missing anchor by NOT clearing the pending target and retrying (1097-1098) — a virtualizer could exploit this but must guarantee the row eventually mounts.
- **Jump-to-bottom on conversation switch** — relies on `scrollHeight` of the fully-rendered list (1092). With virtualization total height is estimated; snapping to bottom needs the virtualizer's total-size API, and the current code writes `scrollTop = scrollHeight` directly.
- **Reference-equality memo** — `MessageBubble` bails out via `prev.message === next.message` (965). This design is compatible with virtualization, but the streaming re-pin/measure interplay must be preserved.
- **Copy buttons** — two independent copy affordances: `MessageActionBar` per bubble (662-733, shown on `group-hover`) and per-code-block `CopyButton` (`DesktopMarkdownMessage.tsx:132-159`). Both use local `useState` + a 2s reset timer; unmounting mid-timer is already guarded (cleanup effects 688-694, 136-142). Virtualization that unmounts rows will reset "Copied" state and lose hover targets for off-screen rows (acceptable, but note the `group-hover` reveal depends on the row being present).
- **Keyboard focus** — the composer textarea is focused via `queueMicrotask(() => inputRef.current?.focus())` after many actions; the inline edit `<Textarea>` uses `autoFocus` (2226). These live in the composer / edited row, not off-screen rows, so virtualization is mostly safe here — but an edited user row that scrolls off-screen and unmounts would drop the editor and its focus.
- **Slash command panel** — lives in the composer (`DesktopComposer`), not the message list; unaffected by list virtualization. (Panel item scroll uses `scrollIntoView` in `DesktopComposer.tsx:236`.)
- **Inline slash chips in user bubbles** — rendered per user message (897-932) using `knownSlashCommands`; only matters for mounted rows.
- **`AgentRunPanel` open/measure state** — `<details>` open state and `InlineClampStep`'s per-instance `useState`/`ResizeObserver` measurement (206-301) are local component state. Unmounting an off-screen agent message loses expanded/More-Less state and forces a re-measure (and re-run of the binary-search clamp) when it re-mounts.
- **Deferred code highlight** — if a large code block mounts and unmounts before its idle callback fires, the highlight is cancelled (`scheduleIdle` returns a cleanup that cancels, 116-130; effect cleanup 197). Re-mounting restarts from the plain-text placeholder. Repeated mount/unmount during fast scrolling could keep large blocks perpetually un-highlighted.
- **Selection / find-in-page** — there is **no custom find-in-page or "jump to message" feature** in the codebase (only the two auto-scroll behaviors). Native browser text selection and Cmd/Ctrl+F rely on off-screen content being in the DOM; virtualization that unmounts rows will break native find-in-page across the full conversation and cross-message text selection. (Confirmed: no `scrollIntoView`/`findInPage`/`IntersectionObserver` usage in the message list; the only `scrollIntoView` is in the composer's slash panel.)
- **Streaming smoother lifecycle** — `DesktopStreamingMarkdownMessage` creates/cancels its `TextStreamSmoother` on mount/unmount (18-31). If the streaming assistant row is virtualized out and back, the smoother resets and `renderedContent` restarts empty until the next content diff re-pushes; must keep the streaming row mounted (or at least stable) during an active response.
- **Post-stream full reload** — `loadMessages` replaces the whole array (476-485), changing every reference and re-rendering all rows; a virtualizer must handle a full list-identity swap gracefully.

## Caveats / Not Found

- No existing virtualization, no scroll-position persistence per conversation, no scroll-to-bottom button, no "user scrolled up" guard, and no find-in-page/jump-to-message code was found — these are behaviors to design around, not preserve.
- `chatStore.ts` and `DesktopChatArea.tsx` contain non-ASCII (CJK) bytes; `grep` treats them as binary — use `grep -a` when searching these files.
- I did not exhaustively read `useSidecarAgentRun.ts` end-to-end; I confirmed its message-mutation surface (it only writes through `applyStreamEvent`/store actions and does not directly touch scroll or the DOM).
