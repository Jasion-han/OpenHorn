// Actual router + checkpoint implementation; the runtime is a local synthetic writer.
import { mock } from "bun:test";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { ensureCheckpointBackup, finalizeCheckpoint } from "./checkpoints";

const [owned, scenario] = process.argv.slice(2);
const root = await realpath(owned);
const a = path.join(root, scenario === "collision" ? "a-b/c" : "project-a");
const b = path.join(root, scenario === "collision" ? "a/b-c" : "project-b");
await Promise.all([mkdir(a, { recursive: true }), mkdir(b, { recursive: true })]);
await writeFile(path.join(a, "same.txt"), "A-original");
await writeFile(path.join(b, "same.txt"), "B-original");
let observed!: () => void;
const runtimeDone = new Promise<void>((resolve) => {
  observed = resolve;
});
mock.module("./agent/direct", () => ({
  runDirectAgent: async (input: {
    checkpoint: Parameters<typeof ensureCheckpointBackup>[0];
    cwd: string;
    onEvent: (event: unknown) => void;
  }) => {
    await ensureCheckpointBackup(input.checkpoint, "same.txt");
    await writeFile(path.join(input.cwd, "same.txt"), "A-changed");
    await finalizeCheckpoint(input.checkpoint);
    input.onEvent({ type: "done" });
    observed();
  },
}));
mock.module("./agent/claude", () => ({
  runClaudeAgent: async () => {
    throw new Error("No Claude call allowed");
  },
}));
mock.module("./agent/codex", () => ({
  runCodexAgent: async () => {
    throw new Error("No CLI call allowed");
  },
}));
mock.module("./agent/acp", () => ({
  runAcpAgent: async () => {},
  preconnectAcpAgent: async () => ({}),
}));
mock.module("./agent/skills", () => ({ resolveSkills: async () => [] }));
const print = console.log;
let announce!: (port: number) => void;
const ready = new Promise<number>((resolve) => {
  announce = resolve;
});
console.log = (...args: unknown[]) => {
  try {
    const value = JSON.parse(String(args[0]));
    if (value.type === "ready") {
      announce(value.port);
      return;
    }
  } catch {}
  print(...args);
};
await import("./index");
console.log = print;
const socket = new WebSocket(`ws://127.0.0.1:${await ready}`);
await new Promise<void>((resolve) =>
  socket.addEventListener("open", () => resolve(), { once: true }),
);
let seq = 0;
const waiting = new Map<string, (value: { ok: boolean; result?: { runId: string } }) => void>();
socket.addEventListener("message", (event) => {
  const value = JSON.parse(String(event.data));
  if (value.type === "response") {
    waiting.get(value.requestId)?.(value);
    waiting.delete(value.requestId);
  }
});
const rpc = (method: string, params: unknown) =>
  new Promise<{ ok: boolean; result?: { runId: string } }>((resolve) => {
    const requestId = String(++seq);
    waiting.set(requestId, resolve);
    socket.send(JSON.stringify({ type: "request", requestId, method, params }));
  });
try {
  if (!(await rpc("auth.handshake", { token: process.env.OPENHORN_HANDSHAKE_TOKEN })).ok)
    throw new Error("Handshake failed");
  const accepted = await rpc("agent.run", {
    protocol: "openai",
    apiKey: "fixture-only",
    model: "fixture",
    prompt: "fixture",
    workspaceRoot: a,
  });
  await runtimeDone;
  await rpc("workspace.setCurrent", { root: b });
  const rollback = await rpc("checkpoint.rollback", { runId: accepted.result?.runId });
  print(
    JSON.stringify({
      rollbackOk: rollback.ok,
      a: await readFile(path.join(a, "same.txt"), "utf8"),
      b: await readFile(path.join(b, "same.txt"), "utf8"),
    }),
  );
} finally {
  socket.close();
}
process.exit(0);
