# Systematic reliability audit and fixes

**Goal:** Inspect cross-module state/data lifecycle beyond UI polish and fix reproducible high-impact defects.

**Scope:** Conversation metadata concurrency and list refresh, project create/list consistency, MCP configuration transport correctness, backup import submission/navigation. Review existing ownership/deletion/RAG/sidecar boundaries and record unresolved design/performance observations separately.

**Approach:** Reproduce with isolated adapter/database fixtures first. Serialize per-conversation metadata writes with field-scoped optimistic overlays; invalidate stale list snapshots. Use project revisions and conflict-safe project insertion. Validate MCP input shape and persist updated transport type; invalidate outdated UI health results. Guard import confirmation and late dialogs with operation identity. No new dependencies or schema.

**Constraints:** Preserve dirty tree and existing CAS/lease/sandbox rules; UI Chinese in agent.ts; isolated synthetic tests only, no model/provider calls or real imports. No Git/push/deploy. Do not present static concerns as verified vulnerabilities.

- [x] Reproduce and fix conversation metadata rollback/refresh races with behavioral tests.
- [x] Reproduce and fix project duplicate creation and stale desktop refreshes.
- [x] Test MCP transport edits and invalid input; fix service validation/type updates and stale health display.
- [x] Guard backup import submit/cancel/navigation and distinguish partial outcomes; browser regression.
- [x] Run relevant complete suites, ownership/data-lifecycle regressions, type/format and desktop build; write a scoped audit report and update project knowledge.
- [x] Repair the discovered Docker template drift: pin pnpm to packageManager, preserve workspace paths, use the actual server entry point and port3002, restrict the context and smoke-test an isolated local container without host data mounts.

**Verified:** Server465/Desktop657/Sidecar331/Shared53 (1506 total), settings/MCP/import12 + workbench25 + chat-failure56 browser checks, workspace types/format, macOS bundle, actual Docker build and isolated HTTP smoke all passed. Live server/app restarted; 344 conversations and 2 paused schedules retained. Report and hashed evidence: `docs/2026-11-09_systematic-OpenHorn-audit.md`. No Git operations or external deployment.
