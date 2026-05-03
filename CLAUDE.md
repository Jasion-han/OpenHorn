# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

OpenHorn is a self-hostable AI workspace for chat, agent execution, and provider routing. Turborepo + pnpm monorepo with four apps and four shared packages.

| App | Stack | Port | Runtime |
|-----|-------|------|---------|
| `apps/web` | Next.js 15, React 19, Zustand | 3001 | Node |
| `apps/server` | Hono 4, Drizzle ORM, LibSQL | 3000 | Bun |
| `apps/desktop` | Tauri 2, React 19, Vite | — | Rust + Bun |
| `apps/sidecar` | WebSocket agent runtime | dynamic | Bun |

Shared packages: `packages/shared` (DTO types), `packages/db` (Drizzle schema), `packages/ui` (Radix components), `packages/agent` (scaffolding).

## Commands

```bash
pnpm install                        # Install all deps
pnpm dev                            # Start everything via Turbo
pnpm dev:web                        # Web only
pnpm dev:server                     # Server only
pnpm dev:desktop                    # Desktop (Tauri) only

pnpm build                          # Build all
pnpm typecheck                      # TypeScript check all packages
pnpm check                          # Biome lint + format check
pnpm format                         # Biome auto-fix formatting

# Server
pnpm --filter server exec bun test              # Run all server tests
pnpm --filter server exec bun test <file>        # Run single test file
pnpm --filter server exec tsc --noEmit           # Server type check

# Web
pnpm --filter web exec tsc --noEmit              # Web type check

# Desktop
pnpm --filter desktop exec bun test             # Desktop tests

# Sidecar
pnpm --filter sidecar exec bun test             # Sidecar tests
pnpm --filter sidecar run compile:tauri:host    # Recompile sidecar binary (required after code changes)

# Database
pnpm --filter server run db:push                # Push schema changes
pnpm --filter server run db:studio              # Open Drizzle Studio

# Docker
docker compose up --build                       # Server container
```

## Architecture

**Provider adapter pattern:** `createAdapter(protocol)` converts channels to OpenAI/Anthropic/Google protocols. Agent runtime selection is handled by `channelAgentCheckService.resolveAgentRuntime()`.

**Desktop ↔ Sidecar:** Tauri spawns sidecar as a child process with a random handshake token. Sidecar runs on loopback WebSocket only. All file operations are workspace-bounded with symlink-aware path validation.

**Desktop and Web are intentionally independent component trees** — do not assume they stay aligned.

**Agent event flow:** SDK events → `AgentEvent` objects → SSE/WebSocket → UI. Desktop uses real-time execution stream (not polling fallback).

**Database has two definitions per table** — both must be updated together:
1. Drizzle schema: `packages/db/src/schema/index.ts` (type-safe queries)
2. Bootstrap DDL: `apps/server/src/db/bootstrap.ts` (runtime migration, authoritative for fresh deploys)

## Critical Rules

- **Import shared packages by workspace name** (`import { users } from "db"`), never relative paths
- **`packages/shared/src/types`** is the single source for server ↔ frontend DTO types
- **Git staging:** Always `git add <path> <path>...` — never `git add .` or `git add -A` (repo has long-lived uncommitted changes)
- **Sidecar recompile:** After changing `apps/sidecar/src/`, run `pnpm --filter sidecar run compile:tauri:host` or `cargo check` will fail
- **Chinese UI text:** Must go through `apps/desktop/src/lib/i18n/agent.ts` dictionary — no inline Chinese strings in components, no fallback strings
- **Server baseline noise:** ~15 pre-existing test failures (`db.delete is not a function` etc.) — check if the failure count changes, not the total
- **Desktop test matchers:** Only `toBe`/`toBeDefined`/`toEqual`/`toHaveLength`/`toMatchObject` — no `.not`/`toBeNull`/`toBeLessThanOrEqual` (limited `bun-test.d.ts`)
- **Biome config:** 2-space indent, 100-char line width; `useExhaustiveDependencies` off only in `apps/web/src/**`
- **No Jest/Vitest** — all tests use `bun test`

## Detailed Documentation

Formal project documentation lives in `skills/openhorn/`. Read order:

1. `skills/openhorn/SKILL.md` — task routing and rule priority
2. `skills/openhorn/rules/project-rules.md` — package management, DB sync, agent runtime, env vars
3. `skills/openhorn/rules/coding-standards.md` — formatting, TypeScript, testing, git conventions
4. `skills/openhorn/rules/desktop-rules.md` — component tree, streaming, sidecar wiring
5. `skills/openhorn/rules/sidecar-security.md` — layered security model (8 layers)
6. `skills/openhorn/references/architecture.md` — full architecture reference
7. `skills/openhorn/references/gotchas.md` — known pitfalls with symptoms/fixes
8. `skills/openhorn/workflows/fix-bug.md` — bug fix workflow

## Quick Routing

| Task | Required Reading | Workflow |
|------|-----------------|----------|
| Fix Server bug | `rules/project-rules.md` + `references/architecture.md` | `workflows/fix-bug.md` |
| Fix Desktop bug | `rules/project-rules.md` + `rules/desktop-rules.md` | `workflows/fix-bug.md` |
| Modify Agent runtime | `rules/project-rules.md` + `references/architecture.md` | `workflows/fix-bug.md` |
| Modify DB schema | `rules/project-rules.md` § DB sync | — |
| Modify Sidecar | `rules/project-rules.md` + `rules/sidecar-security.md` | `workflows/fix-bug.md` |
| Other | `rules/project-rules.md` + `rules/coding-standards.md` | best match in `workflows/` |

All paths above are relative to `skills/openhorn/`.

## Environment

```bash
cp .env.example .env
# Required:
DATABASE_URL=file:./data/openhorn.db
JWT_SECRET=replace-me
ENCRYPTION_KEY=replace-with-32-byte-key
# Optional provider keys (also configurable per-user via UI):
OPENAI_API_KEY=  ANTHROPIC_API_KEY=  DEEPSEEK_API_KEY=  GOOGLE_API_KEY=
```
