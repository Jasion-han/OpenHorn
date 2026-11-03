// The actual router with synthetic local runtimes; never contacts a provider.
import { mock } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const [owned, scenario] = process.argv.slice(2);
const cwd = path.join(owned, "project");
await mkdir(cwd);
let release!: () => void;
let held!: () => void;
const gate = new Promise<void>((resolve) => {
  release = resolve;
});
const waiting = new Promise<void>((resolve) => {
  held = resolve;
});
const workspace = await import("./workspace");
const realWorkspace = { ...workspace };
mock.module("./workspace", () => ({
  ...realWorkspace,
  canonicalizeWorkspaceRoot: async () => {
    if (scenario === "disconnect-agent") {
      held();
      await gate;
    }
    return cwd;
  },
  resolveDefaultWorkspaceRoot: async () => cwd,
}));
mock.module("./auth", () => ({
  detectCredentialForProtocol: async () => {
    if (scenario === "disconnect-chat") {
      held();
      await gate;
    }
    return { token: "synthetic-only" };
  },
  detectAllCredentials: async () => [],
}));
mock.module("./agent/skills", () => ({ resolveSkills: async () => [] }));
let discarded = 0;
mock.module("./checkpoints", () => ({
  createCheckpointSession: async () => {
    if (scenario === "checkpoint-failure") throw new Error("Synthetic checkpoint failure");
    if (scenario === "cancel-checkpoint" || scenario === "disconnect-checkpoint") {
      held();
      await gate;
    }
    return { files: new Map(), runId: "synthetic", workspaceRoot: cwd };
  },
  discardCheckpointIfEmpty: async () => {
    discarded++;
  },
  rollbackCheckpoint: async () => ({}),
}));
// Observe ownership through the router's real idle-policy boundary. Capture its
// scheduled callback so the fixture can inspect state without a 30-second wait.
const idle = await import("./connectionIdle");
const realShouldReap = idle.shouldReapIdleConnection;
let ownership: Parameters<typeof realShouldReap>[0] | undefined;
mock.module("./connectionIdle", () => ({
  shouldReapIdleConnection: (...args: Parameters<typeof realShouldReap>) => {
    ownership = args[0];
    return realShouldReap(...args);
  },
}));
let inspectOwnership: (() => void) | undefined;
const originalSetInterval = globalThis.setInterval;
globalThis.setInterval = ((...args: Parameters<typeof originalSetInterval>) => {
  const [callback, interval] = args;
  if (interval === 30_000) inspectOwnership = () => (callback as () => void)();
  return originalSetInterval(...args);
}) as typeof setInterval;
let runtimeCalls = 0;
let allowed: boolean | null = null;
const runtime = async (input: { onEvent: (event: unknown) => void }) => {
  runtimeCalls++;
  input.onEvent({ type: "done" });
};
mock.module("./agent/direct", () => ({ runDirectAgent: runtime }));
mock.module("./agent/chat", () => ({ runChatStream: runtime }));
mock.module("./agent/chatCodex", () => ({ runCodexChat: runtime }));
mock.module("./agent/codex", () => ({ runCodexAgent: runtime }));
mock.module("./agent/acp", () => ({ runAcpAgent: runtime, preconnectAcpAgent: async () => ({}) }));
mock.module("./agent/claude", () => ({
  runClaudeAgent: async (input: {
    requestApproval: (value: unknown) => Promise<boolean>;
    onEvent: (event: unknown) => void;
  }) => {
    allowed = await input.requestApproval({
      toolUseId: "child-id",
      toolName: "Bash",
      toolInput: {},
    });
    input.onEvent({ type: "done" });
  },
}));
const print = console.log;
let ready!: (port: number) => void;
const port = new Promise<number>((resolve) => {
  ready = resolve;
});
console.log = (...args: unknown[]) => {
  try {
    const message = JSON.parse(String(args[0]));
    if (message.type === "ready") {
      ready(message.port);
      return;
    }
  } catch {}
  print(...args);
};
await import("./index");
globalThis.setInterval = originalSetInterval;
console.log = print;
const socket = new WebSocket(`ws://127.0.0.1:${await port}`);
await new Promise<void>((resolve) =>
  socket.addEventListener("open", () => resolve(), { once: true }),
);
let sequence = 0;
const pending = new Map<
  string,
  (value: { ok: boolean; result?: { runId: string }; error?: string }) => void
>();
const events: Array<{ event: string; data: Record<string, unknown> }> = [];
socket.addEventListener("message", (event) => {
  const message = JSON.parse(String(event.data));
  if (message.type === "response") {
    pending.get(message.requestId)?.(message);
    pending.delete(message.requestId);
  } else events.push(message);
});
const rpc = (method: string, params: unknown) =>
  new Promise<{ ok: boolean; result?: { runId: string }; error?: string }>((resolve) => {
    const requestId = String(++sequence);
    pending.set(requestId, resolve);
    socket.send(JSON.stringify({ type: "request", requestId, method, params }));
  });
const waitUntil = async (condition: () => boolean) => {
  const deadline = Date.now() + 3000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Synthetic router timed out");
    await Bun.sleep(5);
  }
};
await rpc("auth.handshake", { token: process.env.OPENHORN_HANDSHAKE_TOKEN });
const params = {
  prompt: "fixture",
  model: "fixture",
  apiKey: "synthetic-only",
  workspaceRoot: cwd,
};
let result: Record<string, unknown>;
if (scenario === "cancel-checkpoint" || scenario === "disconnect-checkpoint") {
  const response = await rpc("agent.run", { ...params, protocol: "openai" });
  const runId = response.result?.runId;
  if (!runId) throw new Error("Router did not accept checkpoint fixture run");
  await waiting;
  inspectOwnership?.();
  if (ownership?.agentRuns.size !== 1) throw new Error("Run preparation did not own the socket");
  if (scenario === "cancel-checkpoint") {
    await rpc("agent.cancel", { runId });
  } else {
    const closed = new Promise<void>((resolve) =>
      socket.addEventListener("close", () => resolve(), { once: true }),
    );
    socket.close();
    await closed;
    await Bun.sleep(20);
  }
  release();
  await waitUntil(() => discarded === 1);
  result = { runtimeCalls, discarded, remainingRuns: ownership.agentRuns.size };
  if (scenario === "cancel-checkpoint") {
    const late = await rpc("agent.cancel", { runId });
    result.lateCancelAccepted = late.ok;
    socket.close();
  }
} else if (scenario.startsWith("disconnect-")) {
  void (scenario === "disconnect-chat"
    ? rpc("chat.stream", {
        model: "fixture",
        protocol: "openai",
        apiKey: "",
        messages: [{ role: "user", content: "fixture" }],
      })
    : rpc("agent.run", { ...params, protocol: "openai" }));
  await waiting;
  const closed = new Promise<void>((resolve) =>
    socket.addEventListener("close", () => resolve(), { once: true }),
  );
  socket.close();
  await closed;
  await Bun.sleep(20);
  release();
  await Bun.sleep(100);
  result = { runtimeCalls };
} else {
  const response = await rpc("agent.run", {
    ...params,
    protocol: scenario === "missing-acp" ? "acp" : scenario === "approval" ? "anthropic" : "openai",
  });
  const runId = response.result?.runId;
  if (!runId) throw new Error("Router did not accept fixture run");
  if (scenario === "approval") {
    await waitUntil(() => events.some((event) => event.event === "approval.request"));
    const approval = events.find((event) => event.event === "approval.request");
    await rpc("agent.cancel", { runId });
    await Bun.sleep(20);
    const late = await rpc("approvals.respond", {
      toolUseId: approval?.data.toolUseId,
      allow: true,
    });
    await Bun.sleep(20);
    result = { lateApprovalAccepted: late.ok, allowed };
  } else {
    await Bun.sleep(30);
    const cancelled = await rpc("agent.cancel", { runId });
    result = {
      leakedRun: cancelled.ok,
      doneEvents: events.filter(
        (event) =>
          event.event === "agent.event" && (event.data.event as { type?: string })?.type === "done",
      ).length,
    };
  }
  socket.close();
}
await writeFile(path.join(owned, "result.json"), JSON.stringify(result));
process.exit(0);
