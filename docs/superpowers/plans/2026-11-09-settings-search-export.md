# Settings, search and export interaction fixes

**Goal:** Extend the authorized interaction audit beyond workbench to concrete settings, search and export defects.

**Design:** Keep current UI structure. Cancel stale sidebar search effects and show search/loading/failure/retry explicitly. Display account identity as read-only because there is no profile-save API. Move custom instruction editing into an account-scoped in-memory store with request guards, explicit load/save errors and draft preservation across reconnect/navigation. Export DTI through the existing native save dialog, returning the actual saved path or cancellation from Rust; backup keeps its directory workflow. Mark the unimplemented library entry as unavailable before interaction.

**Constraints:** Chinese UI copy stays in agent.ts. No new dependencies, schema or account API; no real credential/model/network configuration changes. Preserve unrelated dirty changes; no Git operations. Save-dialog cancellation must not announce success; errors preserve drafts.

- [x] Add scoped custom-instruction editing store and tests for reconnect, save failure, duplicate saves, account changes and stale requests; replace nonfunctional account editor with read-only identity.
- [x] Guard sidebar search responses and add loading/error/retry states; clarify unavailable library entry.
- [x] Return native save result; route DTI through file saving and accurate estimates; protect export submission/cancel.
- [x] Verify with synthetic API/IPC browser scenarios, desktop tests, type/format checks, Rust checks and native app inspection.
- [x] Update the existing interaction research/spec with actual evidence.

**Verified:** Desktop650, Rust attachment module3, settings/search/export browser8 and workbench browser25 checks passed; workspace type/format checks and macOS debug app bundle passed. Native read-only identity, empty search and save-dialog cancellation confirmed; no real settings/file/model/task writes or Git operations.
