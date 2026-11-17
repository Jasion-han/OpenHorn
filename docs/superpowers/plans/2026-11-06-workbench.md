# OpenHorn workbench implementation plan

> **For agentic workers:** Implement by subsystem with focused workers and independent integration review. The user already authorized execution; no routine approval or Git commit is required.

**Goal:** Ship reusable parameterized task recipes and independently versioned text/interactive artifacts after reliability fixes pass.

**Architecture:** Add ownership-scoped versioned server resources; extend the current desktop shell with one workbench entry and two tabs. Reuse Agent send/scheduled execution and the existing Markdown/GenUI sandbox.

**Tech stack:** Existing Hono/Drizzle/LibSQL, React/Zustand/Radix and Bun tests; no new framework.

**Spec:** `docs/superpowers/specs/2026-11-06-workbench.md`.

## Global constraints

- Preserve current dirty tree and fixed reliability behavior; no implicit commit/deploy or model calls.
- Shared DTOs stay in shared/types; schema/bootstrap definitions change together.
- New Chinese UI strings go through agent.ts; reuse current visual tokens and preview sandbox.
- All referenced resources must belong to the authenticated user.
- Version updates require expectedVersion; historical recipe runs and artifact content remain immutable.

## Review focus

- Async prepare must never send into a different conversation after navigation.
- Missing local workspace/disabled tools must reject before generation, including scheduled executions.
- Deleting a source conversation must leave independent artifact content intact.
- Repeated/late UI requests and concurrent version updates must not overwrite another version.
- Backup restore must preserve new resources and version history while rebinding IDs and dropping invalid references.

## Tasks

### 1. Recipe backend and execution contracts

Files: new recipe DTOs/helpers, recipeService/routes/tests; synchronized DB tables; scheduled project/snapshot fields and requirements check.
- [x] Parameter rendering and validation reject missing/unknown/invalid inputs without evaluating code; validate references and version preconditions.
- [x] Add versioned CRUD and prepare/schedule endpoints from the spec; preserve frozen snapshots and project scope.
- [x] Test two-user access, stale updates, historical version prepare and scheduled requirements/project propagation.

### 2. Artifact backend

Files: new artifact DTOs/service/routes/tests; synchronized DB tables.
- [x] Store complete source text or explicit user content in immutable versions, with source ownership/terminal checks.
- [x] Add list/detail/CAS version append/rename/delete; source deletion retains content.
- [x] Test cross-user references, empty/oversized input, concurrent version conflict and independent source lifetime.

### 3. Desktop integration and recipes

Files: workbenchApi/store, WorkbenchView/RecipePanel, App/sidebar/shell state, message actions and dictionary.
- [x] Extend shell navigation and create target-bound prompt handoff; retain old welcome flow compatibility.
- [x] Add editable templates/parameters/requirements, three dictionary-backed defaults and run/schedule form.
- [x] Add saved-user-task recipe action, missing-capability errors and loaded/retry/empty states.

### 4. Artifact UI and backup

Files: ArtifactPanel/ArtifactSaveDialog, message action wiring, export/import tests.
- [x] Save assistant messages as new artifacts or explicit new versions; show source/version/raw/preview/export/continue actions.
- [x] Use the current sandbox renderer and an artifact/version state scope; raw editor creates a new immutable version.
- [x] Extend backup/restore with all new resources and versions, remapping user/project/channel/conversation/message identities safely.

### 5. Integration validation and delivery

- [x] Real isolated browser interaction with mocked business API/IPC, no model/provider requests; verify both main workflows and failure paths.
- [x] Server/Desktop full suites, all typechecks, pnpm check, UI production build and Tauri build/check appropriate to changes.
- [x] Independent review, fix findings, update research/spec and record actual verification evidence.
