# Library Batch Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let users select and import multiple Library files in one dialog while preserving per-file validation, versioning, retries, drafts, and existing upload semantics.

**Architecture:** Keep the existing single-file `POST /library` endpoint and run selected files through a sequential desktop queue. The dialog tracks completed and remaining files, removes successful files from its memory-only draft, and leaves a failed file plus later files available for retry.

**Tech Stack:** React 19, Zustand, TypeScript, existing Hono upload route, Bun tests, Playwright browser fixture.

**Spec:** `.trellis/spec/server/backend/project-library.md`

## Global Constraints

- Keep each file on the existing upload/index/version path.
- Preserve per-file quota and validation errors.
- Keep draft files memory-only and account/backend scoped.
- User-visible Chinese copy must come from `apps/desktop/src/lib/i18n/agent.ts`.
- No backend archive or database schema changes are needed.

## Review Focus

- A rejected file leaves itself and later selected files available for retry.
- Successful files disappear from the pending draft even when a later file fails.
- Canceling the native picker preserves the current selected file list.
- Selecting an unsupported or oversized file reports its name and does not enqueue it.
- A duplicate same-name file still follows the existing version/dedupe behavior.

### Task 1: Draft and dialog queue

**Files:**
- Modify: `apps/desktop/src/stores/libraryDraftStore.ts`
- Modify: `apps/desktop/src/components/library/LibraryUploadDialog.tsx`
- Modify: `apps/desktop/src/lib/i18n/agent.ts`
- Modify: `apps/desktop/src/components/library/LibraryUploadDialog.submit.test.ts`

- [x] Change the upload draft from one `File` to a scoped `File[]`.
- [x] Allow multiple file selection and DOM file drops, and validate each file independently before enqueueing.
- [x] Submit files sequentially, clear each accepted file from the draft, and preserve the failed and later files.
- [x] Show selected file count, completed progress, file names, and invalid-file feedback.
- [x] Preserve discard confirmation, picker cancellation, one-submit locking, and account reset behavior. Pause and navigation stop the queue after the current file.
- [x] Update source-level handler tests for queue completion and partial failure.

### Task 2: Browser regression coverage

**Files:**
- Modify: `apps/desktop/scripts/library.browser.mjs`

- [x] Add a multi-file upload flow and verify both documents appear.
- [x] Verify the usage count increases for both files.
- [x] Keep the existing duplicate, version, scope, stale request, and deletion assertions.

### Task 3: Verification

- [x] Run focused upload tests and full desktop tests.
- [x] Run the Library browser flow.
- [x] Run `pnpm typecheck`, `pnpm check`, and `git diff --check`.
- [x] Keep the single-file server endpoint and backup format. Correct the existing versioning upgrade so indexes are created after the columns, and verify a legacy original survives two boots.
