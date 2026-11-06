# Attachment Preview Implementation Plan

**Goal:** Apply the attachment interactions approved in the conversation: clicking any chip opens a viewer or actionable file information.
**Architecture:** Shared dialog for composer and message attachments, authenticated original-file loading, lazy PDF rendering, safe Markdown rendering, explicit native save/open. Local Agent file bytes remain local; historical metadata-only records show an unavailable message.
**Tech Stack:** Existing React 19, Radix UI, pdfjs-dist, react-markdown, Bun and Tauri.
**Spec:** User-approved attachment behavior in this conversation; this document records implementation choices.

## Constraints and design

Extend the existing UI, using its typography, semantic colors and dialog components. Quiet hover/focus feedback, compact toolbar, readable full filename, bounded viewport. No new dependencies, model calls, uploads for local Agent files, or Git commits. Chinese UI copy comes from agent.ts. Preserve unrelated dirty files.

## Tasks

- [x] Add classification/original-file loading utilities and regression tests: MIME/extension fallback, HTML as text, unsupported/empty/large text, missing/auth/network errors.
- [x] Add shared viewer: image zoom/gallery; bounded searchable/copyable text with explicit truncation; safe Markdown source/render toggle; lazy PDF page/zoom; audio/video controls; actionable unsupported/error states. Revoke viewer object URLs and cancel stale reads.
- [x] Wire composer and message chips to viewer; keep local files available during the session without altering metadata sync contracts.
- [x] Add native save dialog and explicit safe document opening; browser save fallback. Verify path-safe names and prevent executable opening.
- [x] Run focused Bun tests, TypeScript, touched-file Biome and production UI build. Exercise viewer interactions in an isolated browser fixture if available.

## Review focus

Missing originals must not become blank dialogs; metadata-only history stays honest. Never render HTML/SVG/Markdown as active uploaded documents. Switching/closing during fetch must not leak object URLs or show stale bytes. Large text must not freeze the UI or silently truncate. Composer removal must not activate preview.

## Validation

- `pnpm typecheck`: all configured workspace checks passed.
- Desktop `bun test`: 600 passed, zero failures.
- Rust `cargo test --lib`: 47 passed, zero failures.
- Isolated browser fixture: keyboard/composer preview, removal, text/search/clipboard/full download, inert Markdown/HTML, auth/missing/empty/large-file states, images/gallery/zoom, PDF rendering/page/zoom/search, audio decoding, invalid-video fallback, narrow/dark UI; no page errors or external requests.
- Touched-file Biome and production UI build passed. Native command compiles and is unit-tested; OS save dialogs/external app launch were not driven in the browser fixture and require the rebuilt Tauri application.
- Local Agent bytes remain temporary and are unavailable after conversation cleanup/restart; metadata-only history cannot recover originals.
