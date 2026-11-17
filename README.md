# OpenHorn

OpenHorn is a self-hostable AI workspace for chat, agent execution, provider routing, and optional live web search.

It combines:
- a Tauri desktop client
- a Bun + Hono API server
- Agent runtimes for Claude, Codex, direct model tools, and ACP agents
- a local sidecar runtime for workspace-bounded agent execution

## What It Does

- Multi-turn chat with conversation history
- Agent mode for task-oriented execution
- Channel / model management across providers
- Optional live search routing for current-information questions
- Attachment support
- Inline message edit and regenerate flows
- Conversation auto-titling
- Versioned task recipes with parameters, project bindings, capability checks, and scheduled runs
- An artifact workbench for saved replies, interactive previews, immutable versions, and export
- Durable local recovery for final Agent replies that have not reached the server

## Apps

- `apps/server`: Bun API server
- `apps/desktop`: desktop shell
- `apps/sidecar`: local sidecar service

## Tech Stack

- Tauri 2
- React 19
- Vite
- Bun
- Hono
- Drizzle ORM
- Turborepo
- pnpm workspaces
- Claude Agent SDK

## Quick Start

### 1. Install dependencies

```bash
pnpm install
```

### 2. Create environment file

```bash
cp .env.example .env
```

Set at least:

```bash
DATABASE_URL=file:./data/openhorn.db
JWT_SECRET=replace-me
ENCRYPTION_KEY=replace-with-32-byte-key
```

Optional provider keys:

```bash
OPENAI_API_KEY=
ANTHROPIC_API_KEY=
DEEPSEEK_API_KEY=
GOOGLE_API_KEY=
```

## Run Locally

Start everything:

```bash
pnpm dev
```

Or run services separately:

```bash
pnpm dev:server
pnpm dev:desktop
```

Default local ports:
- Server: `3002` (override with `PORT`)

## Useful Commands

```bash
pnpm build
pnpm typecheck
pnpm check
pnpm format
```

Server-specific:

```bash
pnpm --filter server dev
pnpm --filter server exec tsc --noEmit
pnpm --filter server exec bun test
```

## Live Search

OpenHorn supports optional live search for prompts that need up-to-date external information.

- If live search is allowed but not needed, the assistant answers directly.
- If live search is needed and configured, the app can route to `web_search` or `research`.
- Tavily can be configured per user or via server environment/settings.

## Agent Mode

Agent mode is optimized for task execution rather than plain chat.

Current behavior:
- Agent mode now carries recent conversation context for short follow-up turns.
- The first implementation keeps the latest bounded conversation window instead of replaying the entire session.
- Historical tool traces are not re-injected into the prompt.

## Workbench

Open **工作台** in the desktop sidebar. **任务配方** includes competitor research,
CSV analysis, and code review templates. Save a recipe, fill its parameters, and
run it immediately or create a scheduled task. CSV and code templates read files
from a bound local project. Scheduled recipes currently use Markdown output and
need the desktop sidecar to be online; an expired execution is reported as failed
instead of automatically repeating its tools.

Use the action beneath a saved assistant reply to collect an independent
**已保存成果**. Review its versions, preview Markdown/HTML/OpenUI with the existing
sandbox, export its original text, or continue editing in a new conversation.
Deleting the source conversation preserves the saved artifact. This first release
stores text and interactive page content; it does not copy arbitrary generated
binary files from local paths.

The existing sidebar search now groups conversation titles/messages, saved results,
recipes, projects and review projects. It uses local keyword queries without model
calls and shows at most eight results per type. Search covers current saved-result
content and recipe task text; review projects are matched by name.

Open version history from the workbench's More menu to compare an older result or
recipe with the current version. Confirming restore creates a new version and
preserves existing history and frozen scheduled tasks. Large comparisons use a
bounded plain-text view; restoration always copies the complete saved content.

Agent result saving retries only persistence. Final payloads are retained in the
app profile under the current server/user, with stable identities and save
preconditions. Conflicts preserve the local result and offer explicit copy/discard
actions rather than overwriting a newer server message.

Backups include recipes and artifact version history. Access credentials and
sensitive configuration are omitted; imported MCP connections require setup and
manual enabling. Missing attachment originals are listed in the backup manifest
and desktop export result.

## Docker

A basic server container is included:

```bash
docker compose up --build
```

The API is available at `http://127.0.0.1:3002`, matching the desktop default.
Run either the local server or this container on that port. The API uses a local
single-user identity, so the Compose port binds to loopback by default.
The build context includes only server runtime sources and dependency manifests;
local credentials, databases, desktop build output and attachments are excluded.

The compose file mounts:
- `./data`
- `./attachments`

## Repository Notes

- Design and implementation notes are kept under `docs/superpowers/`.
- This repository is organized as a workspace monorepo.
- Some agent features depend on Anthropic-compatible configuration.

## Security

Before deploying or sharing:
- do not commit real `.env` files
- rotate any key that may have been exposed
- review provider credentials and JWT secrets

## Status

OpenHorn is under active iteration. Interfaces and routing behavior are still evolving.

### Optional Jev decision assistance

Jev uses OpenRouter's System One endpoint, separately from ordinary chat model channels.
Configure `OPENHORN_JEV_API_KEY` in the server's private environment (local development:
`apps/server/.env`; Docker: the Compose `.env`), then enable it under **Settings → Agent →
Jev**. `OPENHORN_JEV_ENABLED` defaults to `false`; the default daily decision budget is
`OPENHORN_JEV_DAILY_BUDGET_USD=0.05` USD per local user, reset at UTC midnight.

The first release provides explicit quick review sentiment/topic tagging, welcome
suggestion deduplication, server-side search/document reranking, skill recommendations,
and route comparison statistics. Unavailable helpers preserve existing behavior;
route comparisons do not change routing. Keep keys out of client code and backups.
See [implementation and validation](docs/2026-11-09_jev-integration-results.md).
