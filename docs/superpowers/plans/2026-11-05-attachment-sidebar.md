# Attachment Sidebar Implementation Plan

**Goal:** Default attachment preview to the existing right panel while keeping chat usable; provide expanded viewing and narrow-window dialog fallback.
**Architecture:** Extend previewPanelStore with one replaceable attachment tab. Reuse the existing original-file reader for embedded and dialog layouts. Keep existing file/web tabs and panel resize/collapse behavior.
**Tech Stack:** Existing React, Zustand, Radix UI, Bun, Playwright.
**Spec:** User approved right sidebar default in the conversation. Scope is presentation; the documented local Agent original-file persistence limitation remains applicable.

## Tasks

- [x] Add one reusable attachment tab to the preview store, with tests for replacing content, preserving web/file tabs, clamping selection and close/collapse behavior.
- [x] Extract embedded presentation from the viewer; retain expanded dialog, gallery, downloads and all readers. Wire composer/message buttons to open the panel without moving chat focus. Use dialog below 1100 CSS pixels.
- [x] Extend the existing panel renderer and fixture, test sidebar replacement, chat editing, resize, collapse, expand/Escape, narrow dialog and prior original-file cases.
- [x] Run desktop tests/typecheck, touched-file Biome, production build; rebuild/restart the desktop app and inspect the native UI.

## Review focus

Tab replacement must not duplicate file bytes or disturb web history. Closing or removing an unrelated composer chip must not close another preview. Media should stop when its attachment becomes inactive. Pending reads must be cancelled on replacement; object URLs must be released. Fullscreen/keyboard interactions must not consume chat typing or arrow keys outside the viewer. Do not persist File/blob values in metadata or localStorage.

## Verification

602 desktop Bun tests passed, including attachment-tab replacement/clamping and preserved file/web tabs. Full workspace typecheck and touched-file Biome passed. The isolated browser regression passed all prior readers plus default sidebar, live chat editing, single-tab replacement, expand/Escape, resize/collapse and narrow-window fallback, with no external requests or page errors. Debug Tauri app rebuilt and restarted; its real conversation UI loaded. Native sidebar interaction could not be completed because the CUA window became unavailable; no claim of native attachment-click acceptance. Long-term local Agent original-file storage is still separate unfinished work.
