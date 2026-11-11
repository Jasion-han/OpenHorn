# Library reliability and search

Approved scope: fix two-way data-only summary isolation, truthful backup restore, and incomplete PDF indexing first; verify the existing Docker fix independently; then improve local retrieval, stale search loading, and exact message navigation.

1. Filter Review and Library conversations both when generating summaries and before selecting recent summaries. Keep the existing opt-in and ordinary chat behavior. Test existing data-only summaries and blocked generation using synthetic data.
2. Preflight library backup payloads before mutating any data. Report failures after import starts with actual committed counts, a safe section name, and an import history record; preserve prior writes and handle individual library quota conflicts. Verify corrupt archives, runtime interruption, and normal round trips.
3. Preserve the first typed page extraction error that pdf-parse may swallow and check that all pages finished before accepting text. Test the previous 55-page silent truncation plus ordinary text PDFs and page limits.
4. Build the Docker image from a scoped source snapshot with the existing Docker fix, and check the loopback mapping and a temporary container with synthetic data. Leave the existing working tree changes intact.
5. Normalize query and indexed text equivalently, keep broad keyword search distinct from the more selective source picker, and reject ungrounded questions. Clear searching when refresh/scope navigation invalidates the active query. Carry the exact result message ID into the existing virtual chat scroll, with stale-target guards. Verify synthetic Chinese/full-width cases and the actual browser routes.
6. Run focused suites, build and type/format checks, record only verified outcomes.
