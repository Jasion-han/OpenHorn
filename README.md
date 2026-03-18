# OpenHorn

OpenHorn is a self-hostable AI workspace for chat, agent execution, provider routing, and optional live web search.

It combines:
- a Next.js web client
- a Bun + Hono API server
- an Agent mode backed by the Claude Agent SDK
- optional desktop and sidecar apps for local workflows

## What It Does

- Multi-turn chat with conversation history
- Agent mode for task-oriented execution
- Channel / model management across providers
- Optional live search routing for current-information questions
- Attachment support
- Inline message edit and regenerate flows
- Conversation auto-titling

## Apps

- `apps/web`: Next.js frontend
- `apps/server`: Bun API server
- `apps/desktop`: desktop shell
- `apps/sidecar`: local sidecar service

## Tech Stack

- Next.js 15
- React 19
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
pnpm dev:web
pnpm dev:server
pnpm dev:desktop
```

Default local ports:
- Web: `3001`
- Server: `3000`

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

Web-specific:

```bash
pnpm --filter web dev
pnpm --filter web exec tsc --noEmit
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

## Docker

A basic server container is included:

```bash
docker compose up --build
```

The compose file mounts:
- `./data`
- `./attachments`

## Repository Notes

- Design and implementation notes are kept under `docs/plans/`.
- This repository is organized as a workspace monorepo.
- Some agent features depend on Anthropic-compatible configuration.

## Security

Before deploying or sharing:
- do not commit real `.env` files
- rotate any key that may have been exposed
- review provider credentials and JWT secrets

## Status

OpenHorn is under active iteration. Interfaces and routing behavior are still evolving.
