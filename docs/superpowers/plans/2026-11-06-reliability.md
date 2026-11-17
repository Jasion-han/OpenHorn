# OpenHorn reliability implementation plan

> **For agentic workers:** Implement task-by-task using focused workers and an independent final review. This session is already authorized to execute; no additional routine approval or Git commit is required.

**Goal:** Fix the six confirmed reliability issues before introducing reusable task recipes and artifact management.

**Architecture:** Preserve the local-sidecar execution boundary. Use a versioned safe backup format, server-enforced task execution leases, bounded circuit probes and a user/backend-scoped durable save outbox. Keep existing message identity/revision and generation/saving separation contracts.

**Tech Stack:** Bun tests, Hono, Drizzle/LibSQL, React/Zustand/Tauri; pnpm dependencies.

**Spec:** `docs/2026-11-06_optimization-OpenHorn-report.md`, approved for execution by the user on 2026-11-06.

## Global constraints

- Preserve all pre-existing working tree changes; no automatic commit, push or deployment.
- Shared DTOs live in `packages/shared/src/types`; database changes update Drizzle and bootstrap together.
- All new Chinese UI text goes through `apps/desktop/src/lib/i18n/agent.ts`.
- Run tests only against isolated databases; never call paid models or send external business messages for verification.
- Generation status and generated text must not be changed by a save failure; retry saving never repeats the model/tools.
- Keep old opaque message IDs valid; stable IDs and `syncRevision` survive retry and restart.

## Review focus

- Backup files must contain no synthetic credential sentinels and must round-trip attachments; missing files are explicit.
- A live task owned by another client cannot be interrupted or completed by this client; expired leases fence late writes.
- Manual task execution remains pending/running until execution and persistence succeed.
- A half-open channel admits one probe, with bounded recovery when no response arrives.
- Restarted save recovery uses the same user/backend and stable IDs; delete/logout/edit must not resurrect stale output.

## Task 1: Restore safe backup export and restore

**Files:** `apps/server/src/services/exportService.ts`, `importService.ts` as needed; new `backupSanitizer.ts`, `exportService.test.ts`.

**Interfaces:** Keep `exportBackup(userId, outputDir, onProgress?)` return shape. Add a structured manifest warning list for unavailable attachments if needed; read old manifests compatibly. Safe MCP config retains transport definitions and credential placeholders/needs-authorization metadata, not secrets. Settings export uses an explicit safe-key policy.

- [x] Add isolated export/restore and synthetic secret cases; verify current archiver API failure.
- [x] Use archiver 8 named ZIP API, install listeners before completion, propagate both stream and archive errors.
- [x] Strip nested headers/env/URL/argument credentials, exclude unsafe settings and channel keys, and report omitted/missing attachment data.
- [x] Verify ZIP entries, sentinel absence and attachment bytes; preserve old backup imports.

## Task 2: Task execution lease and truthful manual runs

**Files:** `packages/db/src/schema/index.ts`, `apps/server/src/db/bootstrap.ts`, `apps/server/src/services/scheduledTaskService.ts`, `scheduledTaskScheduler.ts`, `apps/server/src/routes/scheduledTasks.ts`, `packages/shared/src/types/index.ts`, `apps/desktop/src/lib/backgroundTaskRunner.ts`, `stores/scheduledTaskStore.ts`, `components/scheduled-tasks/ScheduledTasksView.tsx`; focused tests.

**Interfaces:** Claim a pending run with a per-execution owner token; heartbeat extends its lease; complete validates owner, running status and unexpired lease. Recover only expired runs, never all running records. Manual creation queues a pending run and wakes the existing background runner. Expected stale completions return a conflict rather than overwriting terminal state.

- [x] Test two claimers, non-owner completion, terminal overwrites, expiry and heartbeat on isolated DB.
- [x] Add synchronized lease columns to schema/bootstrap, and atomic claim/heartbeat/completion/recovery operations.
- [x] Add API validation and wire desktop owner/heartbeat/cleanup; use server clock for expiry and handle old running rows safely.
- [x] Queue manual runs through the same execution pipeline; remove premature completed status/prompt replay.
- [x] Verify stopped/failed/saved outcomes, failed persistence, stale owner fencing and migration idempotency.

## Task 3: One bounded half-open probe

**Files:** `apps/server/src/services/circuitBreaker.ts`, `channelService.ts` only if necessary, new breaker tests.

**Interfaces:** Existing `isChannelAvailable` call sites remain supported; half-open state atomically holds one probe and expires the reservation if no result arrives. Preserve explicitly chosen channels and existing fallback semantics unless required for correctness.

- [x] Test cooldown, repeated probe attempts, success/failure and abandoned probe timeout.
- [x] Reserve one recovery probe and release/re-open deterministically on response/timeout.
- [x] Verify fallback selection does not consume a second probe for the same request.

## Task 4: Durable save outbox

**Files:** new `apps/desktop/src/lib/sidecarOutbox.ts` and tests, `sidecarPersistence.ts` and tests, `serverState.ts`, existing auth/reset integration and dictionary as needed.

**Interfaces:** Versioned records keyed by backend/user/message identity contain immutable final payload plus user/assistant snapshots. Write before HTTP sync; remove only on matching ACK or explicit invalidation. Recover after identity/server state loads, rehydrate retained snapshots, retry only persistence with the original `syncRevision`.

- [x] Add storage-injected tests for failed sync→restart→same-ID save and lost ACK deduplication.
- [x] Add bounded validated storage and visible durable-write failure handling; never silently evict unsaved results.
- [x] Scope identity/backend, integrate recovery/reconnect and clear invalidated entries on delete/reset/logout.
- [x] Test replacement run, deletion, stale ACK, corrupted entries, storage failure and account/backend change.

## Task 5: Verification and transition

- [x] Run focused regression tests, server and desktop full Bun tests, all workspace typechecks and `pnpm check` with documented existing baseline if needed.
- [x] Run relevant browser checks with synthetic fixtures for changed task flow; build desktop and Rust checks if changed.
- [x] Review the complete diff, record actual outcomes and update the audit evidence.
- [x] Only after reliability checks pass, design and implement task recipes and artifact management using the existing visual system; maintain a separate product plan.
