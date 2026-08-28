# Research: Virtualizing a streaming chat message list with @tanstack/react-virtual (v3)

- **Query**: How to virtualize a chat message list with variable/unknown row heights, live streaming into the last row, and stick-to-bottom + scroll-restore, using @tanstack/react-virtual v3 in React 19 + Vite.
- **Scope**: mixed (external docs + internal codebase context)
- **Date**: 2026-07-06

## TL;DR

The version of TanStack Virtual currently published (`@tanstack/react-virtual@3.14.5` → `@tanstack/virtual-core@3.17.3`) added **first-class chat support** that removes almost all of the manual bookkeeping this feature would otherwise need:

- `anchorTo: 'end'` — end-anchored mode. Keeps the viewport pinned to the bottom while the **last row grows during streaming**, and keeps the visible item stable when **older history is prepended**.
- `followOnAppend: true | 'auto' | 'smooth' | 'instant'` — auto-scroll to the end on new message append, but **only if the user was already pinned** to the bottom.
- `isAtEnd(threshold?)` / `getDistanceFromEnd()` — detect "user scrolled up" to gate a "Jump to latest" button.
- `scrollToEnd({ behavior })` — imperative jump to bottom (initial mount + the jump button).
- `scrollEndThreshold` — px window that counts as "pinned".
- `takeSnapshot()` + `initialMeasurementsCache` + `initialOffset` — persist/restore measured sizes and scroll position across conversation switches / unmount.
- `shouldAdjustScrollPositionOnItemSizeChange` — the built-in fix for "rows above the viewport re-measure and jump" jank (default already avoids it during backward scroll).

**Verification note (important):** I confirmed by grepping the *published* `@tanstack/virtual-core@3.17.3` ESM bundle that `anchorTo`, `followOnAppend`, `scrollToEnd`, `isAtEnd`, `getDistanceFromEnd`, `scrollEndThreshold`, and `takeSnapshot` are all present — these are **not** unreleased `main`-branch-only features. See Caveats for the version constraint.

---

## Findings

### 1. Dynamic measurement API

#### Core hook
```tsx
import { useVirtualizer } from "@tanstack/react-virtual";

const virtualizer = useVirtualizer({
  count: messages.length,
  getScrollElement: () => parentRef.current,   // may return null before mount
  estimateSize: () => 72,                        // initial guess before measure
  getItemKey: (index) => messages[index].id,     // STABLE id, not index (see §2/§3)
  overscan: 6,
});
```

- **`estimateSize(index)`** — returns the initial/estimated px height (vertical) or width (horizontal). Docs recommend estimating toward the **largest plausible** size so initial offsets are less wrong. Only used until a row is actually measured.
- **`measureElement`** (instance method) — `virtualizer.measureElement(el)`. You attach it as the row's `ref`. It reads `getBoundingClientRect()` by default and installs a `ResizeObserver` on the element, so **any later height change re-measures automatically** — this is exactly what handles (a) streaming tokens growing the last row and (b) code-block syntax highlighting changing height asynchronously. No manual re-measure call is needed for content that changes size in place.
- **The required `data-index` + `ref` pattern** for variable-height rows:

```tsx
<div ref={parentRef} style={{ height: 600, overflow: "auto" }}>
  <div style={{ height: virtualizer.getTotalSize(), position: "relative", width: "100%" }}>
    {virtualizer.getVirtualItems().map((vi) => (
      <div
        key={vi.key}
        data-index={vi.index}              // REQUIRED for measureElement to map the node
        ref={virtualizer.measureElement}   // installs ResizeObserver, auto re-measures
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          width: "100%",
          transform: `translateY(${vi.start}px)`,
        }}
      >
        <Message message={messages[vi.index]} />
      </div>
    ))}
  </div>
</div>
```

- **Manual re-measure triggers** (rarely needed with the ref pattern): `virtualizer.measure()` resets all measurements; `virtualizer.resizeItem(index, size)` sets one item's size explicitly (do not mix `resizeItem` and `measureElement` on the *same* index). If measurement-affecting **options** change (e.g. `getItemKey`), the virtualizer auto-invalidates its cache.
- **React 19 flushSync warning:** `useVirtualizer` accepts `useFlushSync?: boolean` (default `true`). On React 19 you may see `flushSync was called from inside a lifecycle method...`. Setting **`useFlushSync: false`** eliminates it and lets React batch naturally. Strongly relevant here (this app is React 19).
- `directDomUpdates: true` is an advanced perf flag (writes positions/size straight to the DOM, re-renders only on index-range change). Optional; has strict CSS requirements (absolute positioning, container via `virtualizer.containerRef`, don't set main-axis in style).

#### `useCachedMeasurements` — hidden-list gotcha
If the list can be hidden with `display:none` on an ancestor (e.g. switching a tab/panel), the ResizeObserver fires with size `0` and wipes measurements. Toggle `useCachedMeasurements: true` before hiding and `false` when showing to preserve sizes.

---

### 2. Stick-to-bottom during streaming

**Recommended approach (v3.17+): end anchoring, NOT reverse list.** The docs explicitly say you do **not** need `flex-direction: column-reverse`, inverted transforms, or manual `scrollTop += delta` prepend compensation.

```tsx
const virtualizer = useVirtualizer({
  count: messages.length,
  getScrollElement: () => parentRef.current,
  estimateSize: () => 72,
  getItemKey: (index) => messages[index].id,
  anchorTo: "end",          // pins bottom while last row grows; stabilizes prepends
  followOnAppend: true,     // follow new appended msgs ONLY if already pinned
  scrollEndThreshold: 80,   // px window treated as "at the end"
  overscan: 6,
  useFlushSync: false,      // React 19
});
```

- **Streaming growth:** In `anchorTo: 'end'` mode, if the viewport was pinned before the last row's measured size changes, the virtualizer adds the size delta to the offset and keeps the bottom stuck to the newest output. Works through the normal `measureElement` path — streaming tokens and async syntax-highlight height changes are handled the same way.
- **New message append:** `followOnAppend` scrolls to end on append **only when** `isAtEnd(scrollEndThreshold)` was true beforehand. If the user scrolled up to read history, appended messages don't yank them down. Use `'smooth'` for animated follow.
- **Detect "user scrolled up":** poll `virtualizer.isAtEnd()` (or `getDistanceFromEnd()`) to toggle a "Jump to latest" affordance:

```tsx
const [pinned, setPinned] = React.useState(true);
React.useEffect(() => {
  const el = parentRef.current;
  if (!el) return;
  const onScroll = () => setPinned(virtualizer.isAtEnd(80));
  el.addEventListener("scroll", onScroll, { passive: true });
  return () => el.removeEventListener("scroll", onScroll);
}, [virtualizer]);

// Jump button:
<button onClick={() => virtualizer.scrollToEnd({ behavior: "smooth" })} hidden={pinned}>
  Jump to latest
</button>
```

- **Start at the latest message on mount:**

```tsx
React.useLayoutEffect(() => {
  virtualizer.scrollToEnd();
}, [virtualizer]);
```

- **Reverse-list vs forward-list:** Reverse/inverted (`column-reverse`) was the *old* workaround to keep the bottom sticky; it fights selection, keyboard nav, and scroll anchoring. With `anchorTo: 'end'` you use **normal item order + normal scroll container**, which is the current recommendation.

---

### 3. Scroll anchoring / jank & restore

- **Rows above the viewport re-measuring (content shift jank):** The known "items jump while scrolling up" problem is handled by default. `shouldAdjustScrollPositionOnItemSizeChange` defaults to applying the size-delta scroll correction **only when the user is not scrolling backward**, which prevents the jump. Override it only to change that behavior. On iOS WebKit, scroll writes are deferred while a finger is down / during momentum / bounce, then flushed once — preserving native physics.
- **`overscan`** (default `1`) — render N extra rows above/below to reduce blank flashes on fast scroll; costs render time. `6` is a reasonable chat default.
- **`scrollToIndex(index, { align })`** and **`scrollToOffset(offset, { align })`** — `align: 'start' | 'center' | 'end' | 'auto'`. During *smooth* scrolling the virtualizer only measures items within a buffer around the target and prefers **block translation** (translate the whole rendered block by the first item's `start`) so far-away size changes don't shift the target.
- **Restore scroll position on conversation switch (data-set swap):** persist a measurement snapshot + offset, feed them back on remount:

```tsx
// On leaving a conversation:
const snapshot = virtualizer.takeSnapshot();       // only measured (rendered) items
const offset = virtualizer.scrollOffset;
store.set(convId, { snapshot, offset });

// On entering a conversation:
useVirtualizer({
  count: messages.length,
  estimateSize: () => 72,
  getScrollElement: () => parentRef.current,
  getItemKey: (index) => messages[index].id,
  initialMeasurementsCache: saved?.snapshot,  // consumed once on first getMeasurements()
  initialOffset: saved?.offset,               // number | (() => number)
});
```
Items missing from the snapshot fall back to `estimateSize`. Because the component instance usually stays mounted across conversation switches (only `count`/`messages` change), you can alternatively just call `scrollToEnd()` / a stored `scrollToOffset()` in an effect keyed on `conversationId`.

- **Prepend stability requires stable `getItemKey`.** With index keys, a prepend shifts every index and the virtualizer can't identify "the same message" across the update, breaking both anchor restore and snapshot reuse. Use each message's persistent `id`.

---

### 4. Alternatives (brief)

| Option | Pros | Cons / when |
|---|---|---|
| **@tanstack/react-virtual** (recommended) | Native chat mode (`anchorTo:'end'`, `followOnAppend`, `isAtEnd`, snapshots); headless; tiny; React 19 ready | You own all markup/CSS (absolute positioning + total-size spacer) |
| **virtua** (`virtua@0.49.x`) | Very good out-of-box reverse/stick-to-bottom (`VList`/`Virtualizer` `shift`, `reverse`), less boilerplate | Component-based (less headless control); another ResizeObserver model to learn |
| **react-window** | Smallest, battle-tested | v1 has **no built-in dynamic measurement** for arbitrary content (needs VariableSizeList + manual measuring/`resetAfterIndex`); poor fit for streaming variable rows |
| **Non-virtualized windowing fallback** | Simplest; keeps native scroll anchoring & Ctrl-F | Only mount full markdown/highlight for the **last N messages**, render older ones as plain-text/lightweight; DOM grows unbounded on huge convos |
| **No virtualization** | Zero complexity; current behavior | Fine below ~a few hundred messages; the current app already does manual `scrollTop = scrollHeight` |

**When NOT to virtualize:** if typical conversations stay small (tens–low hundreds of messages) the manual scroll approach the app already uses is simpler and avoids measurement jank entirely. Virtualization pays off for long conversations with many heavy markdown/code-block rows. A pragmatic middle ground: keep the current non-virtual list but lazily downgrade markdown rendering for old rows (fallback row 4 above).

---

### 5. Compatibility (React 19 + Vite, bundle, peer deps)

- **Published version:** `@tanstack/react-virtual@3.14.5`, dep `@tanstack/virtual-core@3.17.3`.
- **Peer deps:** `react` and `react-dom` `^16.8.0 || ^17 || ^18 || ^19` — React 19 explicitly supported. No other peer deps. Core has zero runtime deps beyond `virtual-core`.
- **`sideEffects: false`** → tree-shakeable under Vite/Rollup. Bundle is small (headless logic only; core ESM ~45KB unminified, roughly ~10KB min+gzip combined). No CSS ships with it.
- **Vite:** no config needed; standard ESM.
- **React 19 note:** set `useFlushSync: false` to avoid the flushSync-in-lifecycle console warning (see §1).

---

## Internal codebase context (where this would land)

| File Path | Relevance |
|---|---|
| `apps/desktop/src/components/chat/DesktopChatArea.tsx` | 2389-line component that renders the message list. Currently uses **manual** stick-to-bottom: a `pendingScrollTargetRef` (`{type:'bottom'} \| {type:'message',id}`) driven in a `useLayoutEffect` that sets `viewportEl.scrollTop = viewportEl.scrollHeight` (lines ~1081–1116). Messages come from `useChatStore`; rows grouped via `groupMessagesByRound(messages)` (line ~746, memoized ~1079). Anchor DOM nodes tracked in `messageAnchorRefs` map. This is the code a virtualizer would replace. |
| `apps/desktop/src/components/chat/DesktopMessageRow` (memoized row, ~line 957–980) | Row is memoized on `message` reference so non-streaming bubbles don't re-render each token — compatible with virtualization (stable rows measure once). |
| `apps/desktop/src/components/chat/DesktopMarkdownMessage.tsx` | Static markdown render (react-markdown). Height changes when async syntax highlighting resolves → relevant to §1 auto re-measure. |
| `apps/desktop/src/components/chat/DesktopStreamingMarkdownMessage.tsx` | Streaming render — the last row that grows every token → §2 stick-to-bottom. |
| `apps/desktop/package.json` | `react@^19.0.0`, `react-dom@^19.0.0`, `vite@^5.0.0`, `react-markdown@^10.1.0`, `react-syntax-highlighter@^16.1.1`. **No** virtualization lib present today. |

Recent commits (`9c7c789`, `6fe6427`) already touch code-block syntax-highlight timing/height deferral — directly the async-height case §1 must survive.

---

## External References

- Virtualizer API (options + instance): https://raw.githubusercontent.com/TanStack/virtual/main/docs/api/virtualizer.md — `anchorTo`, `followOnAppend`, `scrollEndThreshold`, `scrollToEnd`, `isAtEnd`, `getDistanceFromEnd`, `takeSnapshot`, `initialMeasurementsCache`, `measureElement`, `shouldAdjustScrollPositionOnItemSizeChange`, `useCachedMeasurements`.
- React adapter (`useVirtualizer`, `useFlushSync`, `directDomUpdates`): https://raw.githubusercontent.com/TanStack/virtual/main/docs/framework/react/react-virtual.md
- **Chat guide** (the canonical recipe, reproduced in §2): https://raw.githubusercontent.com/TanStack/virtual/main/docs/chat.md — points to `framework/react/examples/chat` for a full runnable example.
- npm metadata: `@tanstack/react-virtual@3.14.5` (peer react `^16.8||^17||^18||^19`, `sideEffects:false`), dep `@tanstack/virtual-core@3.17.3`.
- Alternative: `virtua@0.49.2` (peer react `>=16.14`).

---

## Caveats / Not Found

- **Version floor is critical.** The chat APIs (`anchorTo`, `followOnAppend`, `scrollToEnd`, `isAtEnd`, `getDistanceFromEnd`, `scrollEndThreshold`, `takeSnapshot`) require `@tanstack/virtual-core >= 3.17.x`. I verified they exist in the **published** 3.17.3 bundle (grep of the unpkg ESM). If a pin resolves to an older `react-virtual` (e.g. an older 3.x whose core is < 3.17), these will be absent and you'd fall back to the classic manual pattern (own scroll listener + `scrollToIndex(count-1,{align:'end'})` + manual `shouldAdjustScrollPositionOnItemSizeChange`). Pin `@tanstack/react-virtual@^3.14.5` or later.
- The **`framework/react/examples/chat`** runnable example is referenced by the guide but I did not fetch its source (docs site route, not confirmed in the raw docs tree). The `chat.md` guide code sketches (reproduced above) are the authoritative snippets.
- Did not benchmark actual min+gzip size in this repo's bundle; figure quoted is an estimate from the ESM source size.
- Whether to virtualize at all is a product/scale decision (§4) — not resolved here; the current manual `scrollTop` approach already works for small conversations.
