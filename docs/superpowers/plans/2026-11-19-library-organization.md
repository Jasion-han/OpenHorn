# Library Organization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add persistent tags and favorites to the Library so users can classify, filter, and prioritize current documents without breaking version chains or backups.

**Architecture:** Store normalized tag names as bounded JSON metadata on each version row and keep the logical metadata synchronized across a version group. Add a favorite flag and scoped list and search filters. The detail pane edits metadata through a revision-checked endpoint, while the existing scope, search, import, version, and backup flows remain unchanged.

**Tech Stack:** Drizzle ORM, LibSQL/SQLite, Hono, React 19, Zustand-free local component state, Bun tests, Playwright browser fixture.

**Spec:** `.trellis/spec/server/backend/project-library.md`

## Global Constraints

- Keep Drizzle schema and bootstrap DDL synchronized.
- Tags are bounded, normalized, deduplicated, and stored without model calls.
- Metadata updates require the owned document revision and preserve version-group semantics.
- User-visible Chinese copy must come from `apps/desktop/src/lib/i18n/agent.ts`.
- Existing backup entry names remain unchanged and include the new metadata fields.

## Review Focus

- An old database gains empty tags and an unstarred state without changing existing originals.
- Updating current metadata propagates it to every version in the same version group.
- A stale revision cannot overwrite newer metadata.
- Favorite and tag filters preserve personal/project/all scope ownership.
- Normalize and deduplicate valid tags. Reject invalid, overlong, or excessive tags without changing the document.

### Task 1: Metadata schema and service

**Files:**
- Modify: `packages/db/src/schema/index.ts`
- Modify: `apps/server/src/db/bootstrap.ts`
- Modify: `packages/shared/src/types/library.ts`
- Modify: `apps/server/src/services/libraryService.ts`
- Modify: `apps/server/src/routes/library.ts`

- [x] Add `tags` and `isFavorite` columns with defaults for existing rows.
- [x] Parse and validate bounded normalized tags.
- [x] Add a revision-checked metadata update service and `PATCH /library/:id` route.
- [x] Add favorite/tag list filters while preserving scope ownership and current-version selection.
- [x] Copy metadata into new versions and synchronize updates across a version group.

### Task 2: Desktop organization controls

**Files:**
- Modify: `apps/desktop/src/lib/libraryApi.ts`
- Modify: `apps/desktop/src/components/library/LibraryView.tsx`
- Modify: `apps/desktop/src/lib/i18n/agent.ts`

- [x] Add favorite and tag filters near the scope selector.
- [x] Add detail-pane controls to toggle favorite and edit display name/tags.
- [x] Preserve busy, revision, stale-navigation, version, and upload guards.
- [x] Keep the light visual treatment and keyboard focus states.

### Task 3: Regression coverage

**Files:**
- Modify: `apps/server/src/routes/library.fixture.ts`
- Modify: `apps/desktop/scripts/library.browser.mjs`

- [x] Test legacy migration, metadata propagation, stale revision rejection, filtered scopes, and backup restore.
- [x] Test favorite/tag editing and filtered browser results.
- [x] Run server and desktop verification.

### Task 4: Verification and spec update

- [x] Run server Library tests and full server tests.
- [x] Run full desktop tests, browser Library flow, typecheck, Biome, and diff checks.
- [x] Update `.trellis/spec/server/backend/project-library.md` with the confirmed organization contract.
