# Runtime Permissions and Cancellation

## 1. Scope / Trigger

Apply these contracts when changing `agent.run`, `chat.stream`, external CLI
transports, default workspace preparation, the Full Access option, or Stop
behavior. UI options must reach the runtime for the current turn. A cancelled
turn must not start a later request or execute a command after a delayed approval.

## 2. Signatures

```ts
type PermissionMode = "default" | "full-access";
// workspace.setCurrent: required string; "" requests the validated default.
type WorkspaceSetCurrentParams = { root: string };
type WorkspaceSetCurrentResult = { workspaceRoot: string };
// AgentRunParams / SidecarRunAgentInput:
workspaceRoot?: string;
type CodexApproval = {
  toolUseId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  decisionReason?: string;
};
// RunCodexAgentInput:
permissionMode?: PermissionMode;
requestApproval?: (input: CodexApproval, signal: AbortSignal) => Promise<boolean>;
// RunAcpAgentInput also accepts permissionMode and an optional second signal
// argument on requestApproval, so callers without cancellation remain valid.

waitForApproval(
  pending: Map<string, (allow: boolean) => void>,
  id: string,
  signal: AbortSignal,
  publish: () => void,
): Promise<boolean>;
```

The WebSocket event remains `approval.request` with `runId`, a host-generated
unique `toolUseId`, `toolName`, `toolInput`, and optional `decisionReason`.
`approval.respond` resolves that host id. CLI request ids are separate protocol
identities and must never be used as the shared connection's approval-map key.

## 3. Contracts

| Runtime / mode | Default or omitted permissionMode | Explicit full-access |
|---|---|---|
| Codex Agent | `untrusted` approval policy, `workspace-write` sandbox | `never`, `danger-full-access` |
| Codex Chat fallback | Explicit `--sandbox read-only`, `approval_policy="never"` | No Full Access control exists in Chat |
| ACP Agent | Classify execute requests; ask host for risky commands | Skip risk approval for this turn only |
| Direct Agent | Risk approval for shell commands | Skip risk approval for this turn only |

- Codex sets the same policy in process config and `thread/start`, and builds
  its developer instructions with the actual per-run permission mode.
- Codex supports `item/commandExecution/requestApproval` and
  `item/fileChange/requestApproval`. The host response becomes single-use
  `accept` or `decline`. A cancelled/failed approval becomes `cancel`.
  No callback means decline. Unknown child methods receive JSON-RPC `-32601`.
- Dispatch child requests (`id` plus `method`) before looking up outgoing RPC
  responses. Both numeric and string child ids are valid; opposite directions
  have independent id namespaces.
- On Codex finish/Stop, cancel pending child approvals, abort their host signal,
  settle outgoing RPC promises, remove listeners, and terminate/await the child.
  Spawn it in an owned process group on POSIX and kill the group, including
  descendants remaining after the app-server leader exits.
  Recheck cancellation after binary discovery; do not spawn a pre-cancelled run.
- ACP stores permissionMode on `TurnState`, never on cached session entries.
  Its existing workspace filesystem boundaries remain active in both modes.
  Abort during initialize/session creation kills the owned child and never
  submits a prompt. Abort after model-config awaits must also skip the prompt.
  Client filesystem requests require an active, non-cancelled turn. Recheck
  turn identity/cancellation after checkpoint backup before starting a write.
- Direct `Agent.prompt()` creates a fresh controller: calling `Agent.abort()`
  before prompt does not cancel the future request. Check the caller signal at
  entry and again after asynchronous setup, before prompt. Pass the pi tool's
  signal into `executeTool`, check it after approval, and supply it to shell
  execution. Host approval ownership ends on Stop.
  The shell runner owns a detached POSIX process group; Stop/timeout/output
  overflow kills the group and waits for close. Killing only the parent shell
  leaves background descendants able to write after Stop. Direct write/edit
  tools recheck after backup/path/read/mkdir awaits, immediately before writing.
  Grep/find also receive cancellation signals and sanitized environments.
- A live Chat/Agent run or pending approval owns its WebSocket regardless of
  time since the last client input. `connectionIdle.ts` permits the five-minute
  reaper only when both ownership maps are empty. Disable Bun's separate
  WebSocket idle timeout (`idleTimeout: 0`) so it cannot override this rule;
  outgoing run events also refresh the activity timestamp.
- Per-run UI instructions and history are independent of access mode. Codex
  uses developer instructions; ACP separates request instructions from user
  context; Direct includes them in its system prompt. Omitted instructions
  must not leak from a prior run on the same session.
- `workspace.setCurrent` requires a string `root`, and `""` is the desktop's
  default-workspace sentinel. The protocol must let it reach the router's
  `resolveDefaultWorkspaceRoot`, which creates the dedicated
  `<home>/OpenHorn Workspace` directory and canonicalizes/validates it. A root
  with non-whitespace characters goes through `canonicalizeWorkspaceRoot`;
  invalid explicit paths reject without falling back. Return the canonical
  `workspaceRoot` to the caller. Do not reject the sentinel with `.min(1)`, or
  fresh Agent conversations fail before runtime/model startup. This preparation
  contract differs from `agent.run.workspaceRoot`: an explicit empty or
  whitespace run root remains invalid; pass the resolved preparation result.
- Workspace selection belongs to the run as well. The desktop carries the
  root returned by its successful workspace preparation in `agent.run`'s
  `workspaceRoot`; failure must stop preparation. The sidecar canonicalizes
  and checks that directory before accepting a run, then passes the captured
  `cwd` to Direct, Codex and ACP. Explicit empty, invalid, nonexistent or forbidden
  roots reject without falling back or launching a runtime. A stopped turn's
  delayed `workspace.setCurrent` RPC must not redirect a newer turn. Do not
  depend on the order of independently awaited connection-level RPCs.
  Older callers that omit the field capture the connection's current root,
  or the existing allowed default, for compatibility. The allowed-roots and
  permission policies do not change. ACP session reuse already includes `cwd`
  in its config key; a session preconnected in another project is not reusable.

## 4. Validation & Error Matrix

| Condition | Required result |
|---|---|
| Codex `params.turn.status === "failed"` | Forward `turn.error.message`, then one done event |
| Codex `params.turn.status === "interrupted"` | Report interruption, then done |
| Codex Chat JSON `turn.failed`, including empty stderr | Emit the provider failure, never a success done |
| Codex Chat nonzero exit without a JSON failure | Emit stderr/error event or a nonempty exit-code fallback |
| Older flat Codex completion payload | Continue accepting `params.status/error` |
| Unknown child method, including id collision | `-32601`; do not consume our pending response |
| Host declines command/file approval | `decline`; never blanket accept |
| Stop while initializing / waiting for approval | No later prompt or approval acceptance; child closes |
| Stop before Direct setup / during setup | Zero provider requests |
| Late approval after Direct Stop | Zero shell side effects |
| Stop during Direct write/edit checkpoint backup | Preserve original file |
| ACP filesystem request after Stop | Reject before reading/writing |
| Long run / approval wait past socket idle threshold | Keep socket connected |
| ACP full-access followed by default reused session | Second turn asks again |
| Host event publication throws | Remove approval resolver and reject the request |
| `workspace.setCurrent` with `root: ""` | Return a canonical validated dedicated default; pass that result to the run |
| Missing/non-string preparation root or forbidden/nonexistent/NUL path | Reject; do not return a fallback or start a runtime |
| Old stopped workspace RPC completes after the new project was selected | Explicit per-run workspace remains the new project |
| Explicit empty/nonexistent/file/forbidden run root | Reject before runtime acceptance; no fallback |
| ACP preconnected session belongs to another workspace | Start a new session in this run's canonical cwd |

## 5. Good / Base / Bad Cases

- Good: a default Codex run requests a file change, the user declines, and the
  child receives exactly that decline. Stopping a later run clears its approval.
- Base: a fresh conversation has no saved/project root; `workspace.setCurrent`
  resolves its empty sentinel, and `agent.run` uses that canonical directory.
- Bad: force every Codex run to full access or return `{decision:"accept"}`
  for every child method. Unknown protocol requests can require other payloads
  and may represent actions unrelated to command approval.
- Bad: reject an empty preparation sentinel, or relax the run-root check to
  hide that failure and silently launch in another directory.

## 6. Tests Required

- `runtimePermissions.test.ts` uses actual fake Codex/ACP subprocesses: check
  omitted/default/full modes, numeric/string ids, collisions, unknown methods,
  declined approval, nested failed completion, preabort, discovery cancellation,
  pending approval cancellation, ACP initialization cancellation and session
  mode reset. Local SSE verifies zero Direct requests for a pre-cancelled run;
  a harmless temporary marker verifies no late-approved shell side effect.
- `shell.test.ts` and the Codex descendant fixture verify a delayed background
  child cannot write after Stop. Direct write/edit regressions cancel while a
  real checkpoint backup is pending and assert the original file is unchanged.
  The ACP fixture requests `fs/write_text_file` after `session/cancel`, and the
  host rejects it. Always canonicalize temporary workspace roots; macOS `/var`
  versus `/private/var` aliases can cause a false pass from a path-boundary error.
- `connectionIdle.test.ts` checks expiry at the boundary, live run ownership,
  pending approval ownership, and expiry after ownership ends.
- `approval.test.ts` checks resolver cleanup, late replies and pre-cancelled
  publication. `runtimePrompt.test.ts` inspects actual submitted payloads with
  per-run instructions present and omitted on external transports, and checks
  a real failed exec child emitting JSON with empty stderr cannot appear done.
- `runtimeModes.test.ts` drives real Direct and Chat streams using a loopback
  SSE provider. Verify both Interactive states, preserved prior turns, a real
  two-step file-tool loop, accumulated usage, Stop during setup, and Stop after
  partial output. These tests must never call a real model/provider.
- Full Server tests use `apps/server/bunfig.toml` and an explicitly disposable
  `OPENHORN_TEST_DATABASE_URL`; never run against the normal app's SQLite file.
- `index.workspace.test.ts` starts the actual RPC router in an owned child,
  gates only the old root's canonicalization, and mocks runtime entry points.
  Send the serialized empty preparation sentinel through the actual protocol;
  use the real default resolver with a disposable home and assert that its
  canonical result reaches the runtime. Snapshot the resolver before mocking
  its module, so the wrapper cannot recurse into its replacement. Retain
  missing/non-string/invalid preparation refusals and strict empty run refusal.
  Check late stopped setup, canonical symlink roots across Direct/Codex/ACP,
  explicit invalid-root refusal and omitted-root compatibility. Its token,
  TMPDIR, workspaces and checkpoint home must all be disposable. The ACP
  workspace test uses real local fake subprocesses to verify a preconnected
  process in project A is not reused for a run in project B; no provider calls.

## 7. Wrong vs Correct

```ts
// Wrong: the router never receives the desktop's default sentinel.
const preparation = z.object({ root: z.string().min(1) });
// Correct: keep the required string and resolve/validate it in the router.
const preparation = z.object({ root: z.string() });
const { workspaceRoot } = await rpc("workspace.setCurrent", { root: "" });
await rpc("agent.run", { ...run, workspaceRoot });

// Wrong: defaults silently bypass the visible permission control.
sendThreadStart({ approvalPolicy: "never", sandbox: "danger-full-access" });
// Correct: only the explicit toggle grants full access.
const full = permissionMode === "full-access";
sendThreadStart({
  approvalPolicy: full ? "never" : "untrusted",
  sandbox: full ? "danger-full-access" : "workspace-write",
});

// Wrong: abort() cannot cancel the controller a later prompt() creates.
if (signal.aborted) agent.abort();
await agent.prompt(prompt);
// Correct: skip the call after setup cancellation.
if (signal.aborted) return;
await agent.prompt(prompt);
```
