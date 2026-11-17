# Lifecycle, configuration routing and recovery audit

**Goal:** Continue the authorized audit with reproducible failure/retry/cache defects beyond previous UI/performance work.

**Scope/design:** Protect import history paging/deletion against stale responses and keep picked configuration snapshots immutable. Remove only the attachment file created by a failed upload when its database insert fails. Restrict embedding credentials to compatible OpenAI API-key channels and keep MCP roster names as own data keys. Make editor detection failures retryable and successful detection refreshable with a bounded cache and explicit UI feedback.

**Constraints:** Isolated synthetic requests/database/files only; no provider calls or real file deletion/config changes. Chinese UI copy in agent.ts; no schema, new dependency, Git or external deployment. Preserve existing importer, attachment ownership, sidecar and performance contracts.

- [x] Add red behavioral regressions for history stale/deletion/snapshot and editor recovery; implement guarded state/cache behavior.
- [x] Reproduce failed upload orphaning and incompatible embedding selection; fix write cleanup and protocol-safe routing; verify MCP special names survive serialization.
- [x] Browser-check history failure/retry/deletion and editor rescan using mocked API/IPC; run relevant suites, types/format and app bundle/native inspection.
- [x] Record exact scope, evidence and remaining candidates in existing project knowledge.

**Verified:** Server469/Desktop663/Sidecar331/Shared53 (1516 total), settings/editor/history16 + workbench25 + chat56 browser checks, types/format and macOS debug bundle passed. Server/app restarted;344 conversations and2 paused tasks retained. Native editor rescan and history delete/cancel confirmed without changing preferences or deleting real data. Report: `docs/2026-11-09_lifecycle-recovery-audit.md`.
