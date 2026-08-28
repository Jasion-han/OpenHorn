# Desktop i18n migration: extract inline Chinese UI strings

## Goal

CLAUDE.md hard rule: all Chinese UI text must go through the i18n dictionary
(`apps/desktop/src/lib/i18n/agent.ts`) — no inline Chinese strings in components,
no fallback strings. The original 2026-07-07 audit estimate (~305 literals across
~17 files) was superseded by the incremental migration itself: the settings/chat/
sidebar namespaces were extracted in earlier passes, and a re-audit found only a
tiny tail of remaining inline literals. **This migration is now complete.**

## Status: complete (2026-07-08)

The only inline Chinese literals left in `apps/desktop/src/components/**` were three
provider brand names — `"OpenAI 兼容"`, `"通义千问"`, `"豆包"` in `ChannelEditorModal.tsx`
and `"豆包"` in `DesktopProviderLogo.tsx`. These are now routed through a new
`providerLabels` group in the dictionary via `getProviderLabel(...)`, following the
existing grouped-object + `type XxxLabelKey` + `getXxxLabel` accessor pattern.

After this change, `grep -rnP '[\x{4e00}-\x{9fff}]' apps/desktop/src/components
--include='*.tsx'` yields only non-UI matches that are correctly left alone:
* `DesktopLeftSidebar.tsx` — a `//` code comment.
* `DesktopChatArea.tsx` — a `//` code comment.
* `DesktopMarkdownMessage.tsx` — a regex character class (CJK punctuation ranges).

## What I already know

* Dictionary lives at `apps/desktop/src/lib/i18n/agent.ts`. Grouped `xxxLabels`
  objects + `type XxxLabelKey` + `getXxxLabel(key)` accessors, organized by area
  (settings.*, channel.*, chat.*, sidebar.*, provider.*, …).
* Web (`apps/web`) is a separate component tree and out of scope here.

## How it was done

* Extracted the remaining brand-name literals into `providerLabels` and replaced the
  inline strings with `getProviderLabel(...)` calls. Fixed brand names that are
  identical across locales (e.g. `豆包`) are still routed through the dictionary for
  consistency with the no-inline-Chinese / no-fallback rule.
* Pure string extraction, no behavior change. Verified tsc + `bun test` + biome; the
  migrated strings render identically.

## Out of Scope

* `apps/web` inline strings.
* Adding new locales / a language switcher (this task only routes existing zh text
  through the dictionary).

## Acceptance Criteria

* [x] No inline Chinese literals remain in `apps/desktop/src/components/**` (grep for
      CJK range in .tsx yields only code comments and a regex char-class — no UI text).
* [x] All migrated strings render identically to before (pure extraction, no behavior
      change).
* [x] desktop tsc 0 / `bun test` green (134 pass / 0 fail) / no new biome errors
      (the remaining `useExhaustiveDependencies` warnings are pre-existing on HEAD and
      unrelated to this migration).

## Notes

Deferred from the 2026-07-07 optimization pass (batches 1–5 covered security,
adapters correctness, server transactions/queries, and desktop perf; this i18n
debt was split out as its own gradual effort). The bulk of the extraction happened
in earlier per-file passes; this final increment closed out the provider brand-name
tail, completing the task.
