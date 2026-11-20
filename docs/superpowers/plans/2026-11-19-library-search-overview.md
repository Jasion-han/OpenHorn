# Library Search and Overview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Improve the Library's primary browse and search path with indexed retrieval, grouped results, visible headings, and usage statistics while preserving existing scopes, source snapshots, backups, and fallback behavior.

**Architecture:** Add a SQLite FTS5 virtual table for library chunks and keep it synchronized when indexes are created or deleted. The service will prefer FTS5 retrieval and fall back to the current glob matcher when the virtual table is unavailable. The list response will include per-scope counts and byte totals, while the desktop view will render grouped document results and highlighted snippets without changing the existing navigation model.

**Tech Stack:** Hono, Drizzle ORM, LibSQL/SQLite FTS5, Bun tests, React 19, TypeScript, Tailwind utility classes, i18n dictionary.

**Spec:** `.trellis/spec/server/backend/project-library.md`

## Global Constraints

- Keep Drizzle schema and bootstrap DDL aligned for every persistent table change.
- Preserve explicit personal/project scope ownership and the `all` management/search scope.
- Keep upload, local indexing, search, and backup restore free of model calls.
- Preserve the current source snapshot and question payload limits.
- User-visible Chinese copy must come from `apps/desktop/src/lib/i18n/agent.ts`.
- Use Bun tests and the repository's restricted desktop matchers.
- Do not use `git add .` or `git add -A`.

## Review Focus

- A database created before the FTS table exists must still search through the existing matcher and become indexed on bootstrap.
- Reindexing a document must replace old FTS rows without duplicate hits.
- Deleting a document must remove its FTS rows and leave the remaining scope searchable.
- Search results from personal, project, and all scopes must preserve the existing ownership boundary.
- A zero-document scope and a scope containing failed or indexing documents must show truthful counts and capacity.

### Task 1: FTS schema and synchronization

**Files:**
- Modify: `apps/server/src/db/bootstrap.ts`
- Modify: `apps/server/src/services/libraryService.ts`
- Modify: `apps/server/src/routes/library.fixture.ts`

**Interfaces:**
- Produces `ensureLibraryChunksFtsTable(): Promise<void>` in `apps/server/src/db/bootstrap.ts`.
- Produces internal `syncLibraryChunksFts(documentId, writer)` and `deleteLibraryChunksFts(documentId)` helpers in `libraryService.ts`.

- [x] Add the `library_chunks_fts` FTS5 table with `document_id` and `chunk_index` unindexed columns plus indexed `heading` and `text`, using the same trigram tokenizer as message search.
- [x] Backfill existing `library_chunks` rows during bootstrap and make the initializer idempotent.
- [x] Update the successful indexing transaction to replace the document's FTS rows in the same transaction as chunk replacement.
- [x] Update document deletion to remove FTS rows in the same operation where practical, while retaining the existing fallback-safe behavior.
- [x] Add server tests for bootstrap/backfill, reindex replacement, and deletion cleanup.
- [x] Run the focused library server fixture and confirm all assertions pass.

### Task 2: Indexed search and grouped result contract

**Files:**
- Modify: `apps/server/src/services/libraryService.ts`
- Modify: `packages/shared/src/types/library.ts`
- Modify: `apps/server/src/routes/library.ts`
- Modify: `apps/server/src/routes/library.fixture.ts`

**Interfaces:**
- Extend `LibrarySearchResult` with `heading?: string`, `matchCount?: number`, and `snippet?: string` only where the field is present.
- Keep `searchLibrary(userId, scope, query)` returning `{ results: LibrarySearchResult[] }`.

- [x] Build an FTS query from the existing normalized query terms and preserve the existing question-specific keyword filtering.
- [x] Prefer FTS results, group results by document, rank documents by best match plus aggregate match count, and return the best representative chunk for each document with the total match count.
- [x] Keep the existing glob search available when FTS is unavailable, with the same ownership and status filters.
- [x] Generate a safe highlighted snippet from stored text for the desktop UI. Preserve original source text and avoid HTML injection.
- [x] Add service tests for grouped results, full-width/case matching, fallback search, and project/all scope isolation.
- [x] Run the focused server tests and the existing library HTTP fixture.

### Task 3: Library usage statistics

**Files:**
- Modify: `packages/shared/src/types/library.ts`
- Modify: `apps/server/src/services/libraryService.ts`
- Modify: `apps/server/src/routes/library.ts`
- Modify: `apps/desktop/src/lib/libraryApi.ts`
- Modify: `apps/desktop/src/components/library/LibraryView.tsx`
- Modify: `apps/desktop/src/lib/i18n/agent.ts`

**Interfaces:**
- Extend the list response to `{ documents, stats }`.
- Define `LibraryStats` with `documents`, `documentLimit`, `bytes`, and `byteLimit`.

- [x] Calculate stats within the requested scope while preserving user-level quota limits for the displayed denominators.
- [x] Render a compact usage line near the scope selector, using localized formatting and no inline Chinese copy.
- [x] Test empty and populated scope stats through the browser fixture, including personal and project isolation.

### Task 4: Search result presentation

**Files:**
- Modify: `apps/desktop/src/components/library/LibraryView.tsx`
- Modify: `apps/desktop/src/lib/i18n/agent.ts`
- Modify: `apps/desktop/scripts/library.browser.mjs`

**Interfaces:**
- Keep existing `choose(documentId, match)` navigation behavior.
- Render result heading, match count, and highlighted text from `LibrarySearchResult`.

- [x] Group one document to one result row and keep the selected matched chunk visible in the detail pane.
- [x] Render headings when present and use a safe text-based highlight representation.
- [x] Preserve empty states, narrow layout, stale request guards, and clear-search behavior.
- [x] Add browser assertions for grouped result display, heading visibility, usage stats, and a result with markup-like source text.
- [x] Run the desktop library test and browser library flow.

### Task 5: Verification

**Files:**
- No source changes expected.

- [x] Run focused server library tests.
- [x] Run focused desktop library tests.
- [x] Run `pnpm typecheck`.
- [x] Run `pnpm check`.
- [x] Review the diff against the original project-library contract and report any unverified check.
