# Workbench interaction clarity implementation plan

**Goal:** Continue the authorized UX refinement with clear task previews, recoverable editing and visible state.

**Architecture:** Keep existing layout and scheduling boundaries. Use an account-scoped memory store for artifact edit drafts, retain version CAS and existing preview sandbox, and use existing Radix dialogs for intentional discard. No new dependencies or backend schema changes.

**Scope/design:** Preserve artifact edits across item/tab/view navigation during the current login, explicitly label temporary drafts and historical versions, confirm changed recipe editor dismissal, show a collapsible rendered recipe preview, separate list retry from action errors, and expose search reset plus schedule status/menu access. These are implementation choices under the user's existing request to autonomously simplify interactions.

**Constraints:** Chinese UI copy in agent.ts; do not overwrite historical versions, silently send prompts, enable real schedules, call models, commit or discard unrelated changes.

**Review focus:** Drafts clear on account changes; refresh/conflict cannot lose edits; canceling discard retains edits; unchanged forms close normally; old-version edits append a new version; preview performs no API/model calls; empty searches offer recovery.

- [x] Add account-scoped artifact draft store and meaningful isolation/selection tests; wire ArtifactPanel with discard, draft/history labels and search recovery.
- [x] Guard RecipeEditor dismissal and make recipe preview, validation and list failure feedback explicit; make schedule state/actions visible.
- [x] Extend isolated browser checks for navigation/recovery/discard/history/preview/status; run desktop tests, typecheck, format and native build/acceptance.
- [x] Update existing workbench topic with confirmed behavior and actual evidence; no Git commit.

**Verified:** Desktop 641 tests, 20 isolated browser scenarios, workspace type/format checks and macOS debug app build passed. Native recipe preview and artifact draft navigation/discard confirmed. Existing demo artifact still has 3 saved versions; no live models, schedules or Git operations.
