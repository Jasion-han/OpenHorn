# Desktop Sidecar IDE MVP Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a macOS desktop app (Tauri + Vite UI) with a local Bun sidecar that runs Claude Agent SDK to read/edit code in a Workspace, execute commands with safety approvals, and support checkpoint rollback for agent edits.

**Architecture:** Tauri spawns a Bun sidecar (127.0.0.1 random port + handshake token). Desktop UI connects via WebSocket to drive workspace browsing/editing/terminal and to run an Anthropic-only agent loop (Claude Agent SDK) locally. OpenHorn cloud server only provides account auth (Desktop uses Bearer token).

**Tech Stack:** Tauri 2, Vite + React + Mantine, Monaco, Bun, WebSocket (Bun.serve), @anthropic-ai/claude-agent-sdk, Drizzle (server auth existing).

---

## Protocol (Desktop UI ↔ Sidecar)

### Message envelope (JSON)
- Request: `{ type: "request", requestId, method, params }`
- Response: `{ type: "response", requestId, ok: true, result }` / `{ ok: false, error }`
- Event: `{ type: "event", event, data }`

### Required flows
- `auth.handshake`: UI sends `{ token }`; sidecar validates.
- `workspace.setCurrent`: set per-connection workspace root path.
- `fs.*`: directory listing + file read/write.
- `shell.run`: start a command, stream output events, return exit code, support cancel.
- `agent.run`: start agent session, stream events; support cancel.
- `checkpoint.rollback`: rollback a given runId.
- `approvals.respond`: UI responds allow/deny for risky tool requests.

## Task 1: Create Bun sidecar app skeleton

**Files:**
- Create: `apps/sidecar/package.json`
- Create: `apps/sidecar/tsconfig.json`
- Create: `apps/sidecar/src/index.ts`

**Step 1: Add sidecar package scaffold**
- Add scripts: `dev` (bun run watch), `build` (bun build), `compile:mac` (bun build --compile)
- Add dependencies: `zod` (for protocol validation)

**Step 2: Implement basic WS server with handshake**
- Use `Bun.serve({ websocket: { ... } })`
- Read `OPENHORN_HANDSHAKE_TOKEN` from env; refuse all methods until `auth.handshake` succeeds.

**Step 3: Run sidecar locally**
- Run: `cd apps/sidecar && bun run src/index.ts`
- Expected: logs listening port; refuses unauthenticated calls.

**Step 4: Optional commit**
- `git add apps/sidecar/package.json apps/sidecar/tsconfig.json apps/sidecar/src/index.ts`
- `git commit -m "feat(sidecar): add ws server scaffold"`

## Task 2: Define protocol types and zod validators

**Files:**
- Create: `apps/sidecar/src/protocol.ts`
- Create: `apps/sidecar/src/protocol.test.ts`

**Step 1: Write failing tests for request parsing**
- Use `bun test`
- Validate: rejects unknown `type`, missing `requestId`, invalid `method`.

**Step 2: Implement protocol validators**
- Add zod schemas for envelope and for each method params.

**Step 3: Run tests**
- Run: `cd apps/sidecar && bun test`
- Expected: PASS.

**Step 4: Optional commit**
- `git add apps/sidecar/src/protocol.ts apps/sidecar/src/protocol.test.ts`
- `git commit -m "test(sidecar): validate ws protocol"`

## Task 3: Add workspace scoping + path safety helpers

**Files:**
- Create: `apps/sidecar/src/workspace.ts`
- Create: `apps/sidecar/src/workspace.test.ts`
- Modify: `apps/sidecar/src/index.ts`

**Step 1: Write tests for path safety**
- Ensure `resolveInsideWorkspace(root, inputPath)` rejects `..` traversal and absolute paths outside root.

**Step 2: Implement helpers**
- Normalize paths, enforce workspace root, deny symlink escapes (best-effort: lstat + realpath).

**Step 3: Wire per-connection current workspace**
- Add `workspace.setCurrent({ root })` method.

**Step 4: Run tests**
- Run: `cd apps/sidecar && bun test`

**Step 5: Optional commit**
- `git add apps/sidecar/src/workspace.ts apps/sidecar/src/workspace.test.ts apps/sidecar/src/index.ts`
- `git commit -m "feat(sidecar): add workspace scoping"`

## Task 4: Implement fs.list/read/write (MVP)

**Files:**
- Create: `apps/sidecar/src/fs.ts`
- Create: `apps/sidecar/src/fs.test.ts`
- Modify: `apps/sidecar/src/index.ts`

**Step 1: Write tests for fs methods**
- List directory returns stable shape; read returns utf-8 text; write creates/overwrites inside root only.

**Step 2: Implement**
- Use Bun/Node fs APIs.
- Exclude `.openhorn` from list by default (configurable).

**Step 3: Run tests**
- Run: `cd apps/sidecar && bun test`

**Step 4: Optional commit**
- `git add apps/sidecar/src/fs.ts apps/sidecar/src/fs.test.ts apps/sidecar/src/index.ts`
- `git commit -m "feat(sidecar): add fs methods"`

## Task 5: Implement shell.run with streaming output + risk approvals

**Files:**
- Create: `apps/sidecar/src/shell.ts`
- Create: `apps/sidecar/src/shell-risk.ts`
- Create: `apps/sidecar/src/shell-risk.test.ts`
- Modify: `apps/sidecar/src/index.ts`

**Step 1: Write tests for risk classifier**
- Mark as high-risk: `rm -rf`, `sudo`, `curl|bash`, `wget|sh`, obvious fork bombs.
- Mark as low-risk: `pnpm test`, `git status`.

**Step 2: Implement `classifyCommandRisk(cmd)`**
- Return `{ level: "allow" | "confirm", reason }`.

**Step 3: Implement `shell.run`**
- If `confirm`: emit `event: "approval.request"` and wait for `approvals.respond`.
- Spawn with `Bun.spawn`, stream stdout/stderr via WS events.
- Return exit code as response when done.

**Step 4: Run tests**
- `cd apps/sidecar && bun test`

**Step 5: Optional commit**
- `git add apps/sidecar/src/shell.ts apps/sidecar/src/shell-risk.ts apps/sidecar/src/shell-risk.test.ts apps/sidecar/src/index.ts`
- `git commit -m "feat(sidecar): stream shell output with approvals"`

## Task 6: Implement checkpointing for agent edits (not for shell)

**Files:**
- Create: `apps/sidecar/src/checkpoints.ts`
- Create: `apps/sidecar/src/checkpoints.test.ts`
- Modify: `apps/sidecar/src/index.ts`

**Step 1: Write tests for snapshot layout**
- Creates `<workspace>/.openhorn/snapshots/<runId>/manifest.json`
- Backs up original file content on first modification only.
- Rollback restores previous content.

**Step 2: Implement checkpoint store**
- Generate `runId` (uuid).
- `ensureSnapshotForFile(runId, path)` reads original content and writes backup once.
- `rollback(runId)` replays backups.

**Step 3: Add `.gitignore` helper**
- If `.git` exists, ensure `.openhorn/` is ignored (append safely).

**Step 4: Run tests**
- `cd apps/sidecar && bun test`

**Step 5: Optional commit**
- `git add apps/sidecar/src/checkpoints.ts apps/sidecar/src/checkpoints.test.ts apps/sidecar/src/index.ts`
- `git commit -m "feat(sidecar): add agent checkpoints in workspace"`

## Task 7: Integrate Claude Agent SDK in sidecar (Anthropic-only agent mode)

**Files:**
- Create: `apps/sidecar/src/agent/claude.ts`
- Create: `apps/sidecar/src/agent/events.ts`
- Modify: `apps/sidecar/src/index.ts`

**Step 1: Port event conversion**
- Reuse logic from `apps/server/src/services/agentSdk.ts` to convert SDK messages → `AgentEvent`.

**Step 2: Implement `agent.run` method**
- Params: `{ prompt, model, apiKey, cwd }` (cwd is workspace root).
- Set `permissionMode: "default"` (or `"acceptEdits"` only if approvals still enforced for Bash).
- Provide `canUseTool` to:
  - Enforce workspace boundary for Read/Write/Edit/Glob/Grep tools
  - Route risky Bash to `approval.request` flow (same as shell risk)
  - Before approving Write/Edit: call checkpoints `ensureSnapshotForFile(...)`
- Stream converted events to UI.

**Step 3: Add cancel support**
- Maintain an AbortController per run; expose `agent.cancel(runId)`.

**Step 4: Optional commit**
- `git add apps/sidecar/src/agent/claude.ts apps/sidecar/src/agent/events.ts apps/sidecar/src/index.ts`
- `git commit -m "feat(sidecar): add claude agent runtime with approvals"`

## Task 8: Scaffold Tauri app (src-tauri) and Vite + React UI

**Files:**
- Create: `apps/desktop/index.html`
- Create: `apps/desktop/vite.config.ts`
- Create: `apps/desktop/src/main.tsx`
- Create: `apps/desktop/src/App.tsx`
- Create: `apps/desktop/src/styles.css`
- Create: `apps/desktop/src-tauri/Cargo.toml`
- Create: `apps/desktop/src-tauri/src/main.rs`
- Create: `apps/desktop/src-tauri/tauri.conf.json`

**Step 1: Add React/Mantine/Monaco deps to `apps/desktop/package.json`**
- Add: `react`, `react-dom`, `@mantine/core`, `@mantine/hooks`, `zustand`, `@monaco-editor/react`, `monaco-editor`

**Step 2: Create minimal UI shell**
- Mantine provider + layout placeholders: Sidebar (file tree), Editor, Agent pane, Terminal pane.

**Step 3: Add Tauri config and run**
- Wire Vite dev server to Tauri.
- Run: `pnpm --filter desktop dev`
- Expected: desktop window opens showing UI.

**Step 4: Optional commit**
- `git add apps/desktop/package.json apps/desktop/index.html apps/desktop/vite.config.ts apps/desktop/src apps/desktop/src-tauri`
- `git commit -m "feat(desktop): scaffold tauri + vite ui"`

## Task 9: Tauri spawns sidecar + passes WS URL/token to UI

**Files:**
- Modify: `apps/desktop/src-tauri/src/main.rs`
- Modify: `apps/desktop/src/App.tsx`

**Step 1: Add sidecar spawn**
- On app startup, spawn compiled sidecar binary (dev can spawn `bun` process).
- Generate handshake token + pick random port; pass via env/argv.

**Step 2: Expose `sidecarInfo` to UI**
- Provide `window.__OPENHORN_SIDECAR__ = { wsUrl, token }` or via Tauri event.

**Step 3: Manual test**
- Launch desktop; UI connects successfully; sidecar logs authenticated connection.

**Step 4: Optional commit**
- `git add apps/desktop/src-tauri/src/main.rs apps/desktop/src/App.tsx`
- `git commit -m "feat(desktop): spawn sidecar and connect via ws"`

## Task 10: Implement IDE file tree + Monaco tabs + save

**Files:**
- Create: `apps/desktop/src/lib/sidecarClient.ts`
- Create: `apps/desktop/src/stores/ideStore.ts`
- Create: `apps/desktop/src/components/FileTree.tsx`
- Create: `apps/desktop/src/components/EditorTabs.tsx`
- Modify: `apps/desktop/src/App.tsx`

**Step 1: WS client**
- Connect, handshake, request/response, event subscriptions.

**Step 2: Workspace picker**
- Use Tauri dialog to select folder; call `workspace.setCurrent`.

**Step 3: File tree + open**
- Render directories; click file opens tab (read content).

**Step 4: Monaco**
- Bind model per tab; track dirty state; save writes to sidecar `fs.write`.

**Step 5: Optional commit**
- `git add apps/desktop/src/lib/sidecarClient.ts apps/desktop/src/stores/ideStore.ts apps/desktop/src/components apps/desktop/src/App.tsx`
- `git commit -m "feat(desktop): file tree + monaco editor + save"`

## Task 11: Add terminal panel (shell.run streaming)

**Files:**
- Create: `apps/desktop/src/components/TerminalPane.tsx`
- Modify: `apps/desktop/src/stores/ideStore.ts`
- Modify: `apps/desktop/src/App.tsx`

**Step 1: Implement terminal UI**
- Command input + output stream; show cwd, exit code.

**Step 2: Approval modal**
- When `approval.request` event arrives, show modal (Allow/Deny) and send `approvals.respond`.

**Step 3: Optional commit**
- `git add apps/desktop/src/components/TerminalPane.tsx apps/desktop/src/stores/ideStore.ts apps/desktop/src/App.tsx`
- `git commit -m "feat(desktop): terminal with approvals"`

## Task 12: Add agent panel (Anthropic-only) + checkpoint rollback UI

**Files:**
- Create: `apps/desktop/src/components/AgentPane.tsx`
- Modify: `apps/desktop/src/stores/ideStore.ts`
- Modify: `apps/desktop/src/App.tsx`

**Step 1: Agent run**
- Prompt input; run via `agent.run`; stream events to UI.

**Step 2: Checkpoint list + rollback**
- Keep last N runIds; add “Rollback” button calling `checkpoint.rollback`.

**Step 3: Optional commit**
- `git add apps/desktop/src/components/AgentPane.tsx apps/desktop/src/stores/ideStore.ts apps/desktop/src/App.tsx`
- `git commit -m "feat(desktop): agent run + checkpoint rollback"`

## Task 13: Desktop Bearer auth on server (optional for MVP)

**Files:**
- Modify: `apps/server/src/routes/auth.ts`
- Create: `apps/server/src/utils/auth.ts`
- Modify: all server routes that call `getCookie(..., 'token')` (or refactor helper)

**Step 1: Add token to auth responses**
- `POST /auth/login` and `POST /auth/register` response includes `{ user, token }`.

**Step 2: Add `getAuthToken(c)` helper**
- Prefer `Authorization: Bearer ...`, fallback to cookie `token`.

**Step 3: Update routes to use helper**
- So Desktop can call server without cookie/CORS issues.

**Step 4: Manual test**
- `curl -H "Authorization: Bearer ..." /channels` etc.

**Step 5: Optional commit**
- `git add apps/server/src/routes/auth.ts apps/server/src/utils/auth.ts apps/server/src/routes`
- `git commit -m "feat(server): support bearer auth for desktop"`

---

## Execution Options

Plan complete and saved to `docs/plans/2026-03-12-desktop-sidecar-ide-mvp-plan.md`.

Two execution options:
1) Subagent-Driven (this session) — implement task-by-task with review between tasks
2) Parallel Session — open a new session to execute with checkpoints

Which approach?

