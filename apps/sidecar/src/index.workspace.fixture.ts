// Owned router process with deterministic runtimes: no provider or CLI is called.
import { mock } from "bun:test";
import { mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

const owned = process.argv[2];
if (!owned) throw new Error("Owned fixture directory required");
const rootA = path.join(owned, "project-a");
const rootB = path.join(owned, "project-b");
const fixtureHome = path.join(owned, "fixture-home");
await Promise.all([mkdir(rootA), mkdir(rootB)]);
const canonicalA = await realpath(rootA);
const canonicalB = await realpath(rootB);
const aliasB = path.join(owned, "project-b-link");
await symlink(rootB, aliasB);
const fileRoot = path.join(owned, "file-root");
await writeFile(fileRoot, "not a directory");

let announceHeld: () => void = () => {};
const held = new Promise<void>((resolve) => {
  announceHeld = resolve;
});
let releaseOld: () => void = () => {};
const oldGate = new Promise<void>((resolve) => {
  releaseOld = resolve;
});
let holdA = true;
const workspaceModule = new URL("./workspace.ts", import.meta.url).pathname;
const workspace = await import(workspaceModule);
const canonicalize = workspace.canonicalizeWorkspaceRoot;
const resolveDefault = workspace.resolveDefaultWorkspaceRoot;
mock.module(workspaceModule, () => ({
  ...workspace,
  // Keep the real resolver and canonicalization, but create the default only
  // beneath this fixture's disposable directory, never the normal user's home.
  resolveDefaultWorkspaceRoot: () => resolveDefault(fixtureHome),
  async canonicalizeWorkspaceRoot(root: string) {
    if (root === rootA && holdA) {
      announceHeld();
      await oldGate;
    }
    return canonicalize(root);
  },
}));

type Capture = { runtime: string; cwd: string };
const captures: Capture[] = [];
let captured: (() => void) | undefined;
const runtime =
  (name: string) => async (input: { cwd: string; onEvent: (event: unknown) => void }) => {
    captures.push({ runtime: name, cwd: input.cwd });
    captured?.();
    input.onEvent({ type: "done" });
  };
mock.module(new URL("./agent/codex.ts", import.meta.url).pathname, () => ({
  runCodexAgent: runtime("codex"),
}));
mock.module(new URL("./agent/direct.ts", import.meta.url).pathname, () => ({
  runDirectAgent: runtime("direct"),
  executeTool: async () => {
    throw new Error("No tools expected in router fixture");
  },
}));
mock.module(new URL("./agent/claude.ts", import.meta.url).pathname, () => ({
  runClaudeAgent: async () => {
    throw new Error("Claude is forbidden in router fixture");
  },
}));
mock.module(new URL("./agent/acp.ts", import.meta.url).pathname, () => ({
  runAcpAgent: runtime("acp"),
  preconnectAcpAgent: async () => {
    throw new Error("No preconnect expected in router fixture");
  },
}));

const print = console.log;
let announcePort: (port: number) => void = () => {};
const ready = new Promise<number>((resolve) => {
  announcePort = resolve;
});
console.log = (...args: unknown[]) => {
  try {
    const message = JSON.parse(String(args[0]));
    if (message.type === "ready") {
      announcePort(message.port);
      return;
    }
  } catch {}
  print(...args);
};
await import("./index");
console.log = print;
const socket = new WebSocket(`ws://127.0.0.1:${await ready}`);
await new Promise<void>((resolve, reject) => {
  socket.addEventListener("open", () => resolve(), { once: true });
  socket.addEventListener("error", () => reject(new Error("Owned socket failed")), { once: true });
});
let nextId = 0;
const pending = new Map<
  string,
  { resolve: (value: unknown) => void; reject: (error: Error) => void }
>();
socket.addEventListener("message", (event) => {
  const response = JSON.parse(String(event.data));
  if (response.type !== "response") return;
  const waiter = pending.get(response.requestId);
  if (!waiter) return;
  pending.delete(response.requestId);
  if (response.ok) waiter.resolve(response.result);
  else waiter.reject(new Error(response.error));
});
const rpc = (method: string, params: unknown) =>
  new Promise<unknown>((resolve, reject) => {
    const requestId = String(++nextId);
    pending.set(requestId, { resolve, reject });
    socket.send(JSON.stringify({ type: "request", requestId, method, params }));
  });
const run = async (protocol: string, workspaceRoot?: string) => {
  const observed = new Promise<void>((resolve) => {
    captured = resolve;
  });
  await rpc("agent.run", {
    prompt: "Local workspace fixture",
    apiKey: "fixture-only",
    model: "fixture",
    protocol,
    ...(workspaceRoot !== undefined ? { workspaceRoot } : {}),
    ...(protocol === "acp" ? { acpAgent: { command: "fixture-only-not-spawned" } } : {}),
  });
  await observed;
};

try {
  await rpc("auth.handshake", { token: process.env.OPENHORN_HANDSHAKE_TOKEN });
  const defaultWorkspace = (await rpc("workspace.setCurrent", { root: "" })) as {
    workspaceRoot: string;
  };
  const expectedDefault = await realpath(
    path.join(fixtureHome, workspace.DEFAULT_WORKSPACE_DIR_NAME),
  );
  await run("codex_cli", defaultWorkspace.workspaceRoot);
  const defaultRunUsesResolvedRoot = captures.at(-1)?.cwd === expectedDefault;
  const beforeWorkspaceFailures = captures.length;
  let rejectedWorkspaceParams = 0;
  for (const params of [
    {},
    { root: null },
    { root: 123 },
    { root: "/" },
    { root: path.join(owned, "missing") },
    { root: "bad\0root" },
  ]) {
    try {
      await rpc("workspace.setCurrent", params);
    } catch {
      rejectedWorkspaceParams++;
    }
  }
  const invalidWorkspaceParamsStartedNoRuns = captures.length === beforeWorkspaceFailures;
  captures.length = 0;
  const oldPreparation = rpc("workspace.setCurrent", { root: rootA });
  await held;
  const selected = (await rpc("workspace.setCurrent", { root: rootB })) as {
    workspaceRoot: string;
  };
  // Stop prevents the old turn submitting a run, but cannot cancel its RPC.
  holdA = false;
  releaseOld();
  await oldPreparation;
  for (const protocol of ["codex_cli", "openai", "acp"]) await run(protocol, aliasB);
  const explicitCaptures = captures.slice();
  const beforeInvalid = captures.length;
  let rejected = 0;
  for (const workspaceRoot of [
    "",
    "  ",
    "/",
    path.join(owned, "missing"),
    fileRoot,
    "bad\0root",
    null,
  ]) {
    try {
      await rpc("agent.run", {
        prompt: "must reject",
        apiKey: "fixture-only",
        model: "fixture",
        protocol: "codex_cli",
        workspaceRoot,
      });
    } catch {
      rejected++;
    }
  }
  await run("codex_cli");
  const result = {
    defaultWorkspaceResolved: defaultWorkspace.workspaceRoot === expectedDefault,
    defaultRunUsesResolvedRoot,
    rejectedWorkspaceParams,
    invalidWorkspaceParamsStartedNoRuns,
    selectedB: selected.workspaceRoot === canonicalB,
    explicitRuntimes: explicitCaptures.map((entry) => entry.runtime),
    explicitRootsAreB: explicitCaptures.every((entry) => entry.cwd === canonicalB),
    rejectedRoots: rejected,
    invalidRootsStartedNoRuns: captures.length === beforeInvalid + 1,
    legacyOmittedRootIsCurrentA: captures.at(-1)?.cwd === canonicalA,
    canonicalAliasResolved: aliasB !== canonicalB,
    oldPreparationStartedNoRun: explicitCaptures.length === 3,
  };
  print(JSON.stringify(result));
  socket.close();
  process.exit(0);
} catch (error) {
  socket.close();
  throw error;
}
