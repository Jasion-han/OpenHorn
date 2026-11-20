# Library Versioning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Turn same-name Library uploads into a visible version chain while preserving immutable originals, frozen question sources, existing backup payloads, and current-scope search behavior.

**Architecture:** Add version metadata directly to `library_documents` so every original remains independently restorable. New uploads with the same user, scope, and filename create a new current version. The list and search paths select current versions, while a version endpoint exposes the complete chain. Deleting a current version promotes the previous version inside one transaction.

**Tech Stack:** Drizzle ORM, LibSQL/SQLite, Hono, Bun tests, React 19, TypeScript, existing Library dialogs and i18n.

**Spec:** `.trellis/spec/server/backend/project-library.md`

## Global Constraints

- Keep Drizzle schema and bootstrap DDL synchronized.
- Keep immutable original bytes and frozen question source snapshots.
- Preserve the existing `(user, scope, filename, SHA256)` dedupe identity.
- Preserve user ownership and personal/project/all scope rules.
- User-visible Chinese copy must come from `apps/desktop/src/lib/i18n/agent.ts`.
- Do not change backup archive entry names or introduce derived chunks into backups.

## Review Focus

- Uploading a new same-name file creates one newer current version while the old version remains downloadable.
- Re-uploading an existing historical SHA promotes that stored version instead of duplicating the original.
- Search and usage stats exclude historical versions from the visible current list while quotas still count stored originals.
- Deleting the current version promotes the newest remaining version and keeps its FTS row searchable.
- Old backup rows without version columns remain valid after bootstrap and restore as version 1.

### Task 1: Version metadata and migration

**Files:**
- Modify: `packages/db/src/schema/index.ts`
- Modify: `apps/server/src/db/bootstrap.ts`
- Modify: `apps/server/src/services/libraryService.ts`

- [x] Add `displayName`, `versionGroupId`, `version`, `isCurrent`, and `previousVersionId` to the Drizzle schema and bootstrap DDL.
- [x] Add idempotent column/index ensures and backfill existing rows as version 1, current, display name equal to file name, and group id equal to document id.
- [x] Extend `LibraryDocument` and detail DTOs with the version fields.
- [x] Update metadata selection and `documentItem`.

### Task 2: Upload, list, delete, and search semantics

**Files:**
- Modify: `apps/server/src/services/libraryService.ts`
- Modify: `apps/server/src/routes/library.ts`
- Modify: `packages/shared/src/types/library.ts`
- Modify: `apps/server/src/routes/library.fixture.ts`

- [x] Make same-name changed uploads create a new version and demote the prior current version in one transaction.
- [x] Make exact historical SHA uploads reuse and promote the existing version.
- [x] List only current versions, keep all stored versions in quota calculations, and make explicit search/current-source matching ignore historical rows.
- [x] Add `GET /library/:id/versions` and `POST /library/:id/restore` with ownership and revision checks.
- [x] Make current deletion promote the newest remaining version inside the deletion transaction.
- [x] Add fixture checks for new version creation, historical promotion, current deletion promotion, and scope isolation.

### Task 3: Version dialog and UI

**Files:**
- Create: `apps/desktop/src/components/library/LibraryVersionsDialog.tsx`
- Modify: `apps/desktop/src/components/library/LibraryView.tsx`
- Modify: `apps/desktop/src/lib/libraryApi.ts`
- Modify: `apps/desktop/src/lib/i18n/agent.ts`
- Modify: `apps/desktop/scripts/library.browser.mjs`

- [x] Show the current version beside the document status and keep the current list free of historical duplicates.
- [x] Add a history action that opens versions ordered newest first with version number, date, size, and status.
- [x] Allow downloading a historical version and restoring it as current after explicit confirmation.
- [x] Preserve existing delete, OCR, reindex, search, and stale-navigation guards.
- [x] Add browser assertions for version creation, history visibility, restore, and current deletion promotion.

### Task 4: Verification and spec update

- [x] Run server Library tests and full server tests.
- [x] Run desktop tests, browser Library flow, typecheck, and Biome.
- [x] Update `.trellis/spec/server/backend/project-library.md` with the confirmed version contract.
- [x] Review backup export/import behavior for old and new version rows.
