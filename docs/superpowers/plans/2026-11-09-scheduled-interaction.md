# Scheduled task interaction clarity

**Goal:** Continue the authorized interaction audit, making request outcomes, list failures and destructive actions unambiguous.

**Approach:** Keep current task/workbench layout and backend contracts. Extend the existing scheduled-task store with truthful boolean mutation results, per-task pending guards, independent task/run loading errors and latest-request guards. Confirm deletion before submitting; preserve failed items. Keep accepted manual runs executing while late responses cannot steal navigation. Reuse existing discard dialog for changed schedule forms and correct recipe edit copy.

**Constraints:** All Chinese UI copy in agent.ts; no real models or schedule changes in verification; no dependency/schema changes; preserve existing dirty tree and prior recipe snapshot/lease contracts; no Git operations.

- [x] Store: inject request dependency for isolated tests; test failed deletes/toggles, pending deduplication and list errors/stale responses; implement truthful outcomes.
- [x] View: explicit load/retry states, visible pending controls and failure feedback; task/run delete confirmation; guard manual-run navigation after page changes.
- [x] Form: changed-form dismissal confirmation, accurate create/edit recipe wording; clarify create enables automatic execution.
- [x] Browser regressions with synthetic API/IPC for success/failure/cancel/late responses; desktop suite, typecheck, formatting and app build/native inspection.
- [x] Record verified behavior/evidence in existing workbench topic.

**Verified:** Desktop 646 tests, 25 synthetic browser scenarios, workspace type/format checks and macOS debug bundle passed. Native delete confirmation/cancel and create-enabled hint checked; original two tasks remain paused. No real model/task execution, deletion or Git operations.
