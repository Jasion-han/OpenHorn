# Workbench UX simplification implementation plan

> **For agentic workers:** Execute focused subsystems and review integration. User already authorized the change; no routine approval, Git commit or deployment is required.

**Goal:** Make recipes, saved artifacts and scheduled execution distinct while reducing visible controls and nested panels.

**Architecture:** Workbench recipes run once or hand an immutable recipe/version/value draft to the existing scheduled-task dialog. The schedule page remains the sole time/status management surface. Artifact previews retain current storage and sandbox contracts.

**Tech stack:** Existing React/Zustand/Radix, shared DTOs, Hono/Bun; no new dependency.

**Spec:** `docs/superpowers/specs/2026-11-06-workbench-ux.md`.

## Global constraints

Preserve the dirty tree, role/ownership validation, snapshot/CAS/lease/outbox contracts and existing data. Chinese UI copy goes through agent.ts. No real model/task execution in tests.

## Review focus

- Cancelled handoff creates zero schedules; double submit creates one.
- An edited recipe cannot alter the frozen version handed to the schedule page.
- Ordinary task editing remains functional; recipe tasks expose only supported changes.
- Hidden menu actions remain keyboard accessible and version conflict refresh preserves the draft.
- Async navigation cannot steal a newer view or issue a delayed run.

## Tasks

- [x] Add memory-only recipe-schedule handoff, consume it in ScheduledTasksView, extend existing CreateTaskDialog for recipe source and locked prompt; preserve ordinary form behavior. Update schedule request options only as needed to honor existing title/notification controls.
- [x] Simplify RecipePanel/RecipeEditor/WorkbenchView: one primary run action, compact list/detail, secondary schedule transfer, progressive settings and contextual templates.
- [x] Consolidate ArtifactPanel actions into a more menu; compact title/version/actions and source metadata; preserve editing and async guards.
- [x] Add/update meaningful handoff/dialog tests and isolated browser flows; run related full suites, typecheck, pnpm check, UI/Tauri build. Independently review changes and fix issues.
- [x] Verify the built desktop view, update the existing workbench contract/research and record actual results without committing.

## Verified outcome

Server 463 and Desktop 639 tests passed; 14 isolated browser scenarios, workspace typecheck/format checks and macOS debug bundle passed. Native app confirmed schedule handoff/cancel, collapsed recipe settings, artifact menus and interactive preview. Existing demo data retained; no live model execution or schedule creation during this UX acceptance. See `.trellis/research/openhorn-optimization-audit.md`.
