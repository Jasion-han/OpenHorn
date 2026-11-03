import { afterEach, describe, expect, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { access, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createCheckpointSession } from "../checkpoints";
import { runAcpAgent } from "./acp";
import { runCodexChat } from "./chatCodex";
import { runCodexAgent } from "./codex";
import { executeTool, runDirectAgent } from "./direct";
import type { AgentEvent } from "./events";

const fixture = new URL("./runtimePermissions.fixture.ts", import.meta.url).pathname;
const directories: string[] = [];
const children = new Set<ChildProcess>();
const acpPids = new Set<number>();

afterEach(async () => {
  for (const child of children)
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  children.clear();
  for (const pid of acpPids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
  acpPids.clear();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function setup() {
  const directory = await realpath(
    await mkdtemp(path.join(tmpdir(), "openhorn-runtime-permissions-")),
  );
  directories.push(directory);
  const file = path.join(directory, "transport.jsonl");
  const read = async (): Promise<Array<Record<string, unknown>>> => {
    try {
      return (await readFile(file, "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  };
  const events: AgentEvent[] = [];
  const abortController = new AbortController();
  const input = {
    model: "fixture",
    prompt: "fixture question",
    cwd: directory,
    abortController,
    onEvent: (event: AgentEvent) => events.push(event),
  };
  const dependencies = (scenario: string) => ({
    findBinary: async () => "fixture",
    spawn: (
      _command: string,
      _args: string[],
      options: import("node:child_process").SpawnOptions,
    ) => {
      const child = spawn(process.execPath, [fixture, "codex", file, scenario], options);
      children.add(child);
      return child;
    },
  });
  return { directory, file, read, events, abortController, input, dependencies };
}

async function waitUntil(condition: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 3000;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error("fixture did not reach expected state");
    await Bun.sleep(5);
  }
}

describe("runtime permission and cancellation boundaries", () => {
  for (const permissionMode of [undefined, "default", "full-access"] as const) {
    test(`Codex honors ${permissionMode ?? "omitted"} access and each approval decision`, async () => {
      const s = await setup();
      const approvals: string[] = [];
      await runCodexAgent(
        {
          ...s.input,
          permissionMode,
          requestApproval: async (input) => {
            approvals.push(input.toolName);
            return input.toolName === "shell";
          },
        },
        s.dependencies("permissions"),
      );
      const messages = await s.read();
      const thread = messages.find((message) => message.method === "thread/start")
        ?.params as Record<string, unknown>;
      const full = permissionMode === "full-access";
      expect(thread.approvalPolicy).toBe(full ? "never" : "untrusted");
      expect(thread.sandbox).toBe(full ? "danger-full-access" : "workspace-write");
      expect(approvals).toEqual(full ? [] : ["shell", "file_edit"]);
      expect(
        messages.find((message) => message.id === "command-approval" && !message.method)?.result,
      ).toEqual({ decision: "accept" });
      expect(messages.find((message) => message.id === 42 && !message.method)?.result).toEqual({
        decision: full ? "accept" : "decline",
      });
      expect(s.events.filter((event) => event.type === "done")).toHaveLength(1);
    });
  }

  test("Codex rejects unknown requests even when their id collides with an outgoing initialize", async () => {
    const s = await setup();
    await runCodexAgent(s.input, s.dependencies("collision"));
    const messages = await s.read();
    expect(messages.find((message) => message.id === 0 && message.error)?.error).toMatchObject({
      code: -32601,
    });
    expect(messages.some((message) => message.method === "turn/start")).toBe(true);
    expect(s.events.filter((event) => event.type === "error")).toEqual([]);
  });

  test("Codex propagates nested failed turn status", async () => {
    const s = await setup();
    await runCodexAgent(s.input, s.dependencies("failed"));
    expect(s.events).toContainEqual({ type: "error", content: "fixture upstream failure" });
    expect(s.events.at(-1)?.type).toBe("done");
  });

  for (const phase of ["initializing", "pending"]) {
    test(`Codex Stop during ${phase} closes child and ignores late approval`, async () => {
      const s = await setup();
      let lateApproval: ((allow: boolean) => void) | undefined;
      let approvalSignal: AbortSignal | undefined;
      const run = runCodexAgent(
        {
          ...s.input,
          requestApproval: (_input, signal) => {
            approvalSignal = signal;
            return new Promise((resolve) => {
              lateApproval = resolve;
            });
          },
        },
        s.dependencies(phase),
      );
      await waitUntil(async () =>
        phase === "pending"
          ? Boolean(lateApproval)
          : (await s.read()).some((message) => message.method === "initialize"),
      );
      s.abortController.abort();
      await run;
      lateApproval?.(true);
      await Bun.sleep(10);
      expect(s.events.filter((event) => event.type === "done")).toHaveLength(1);
      if (phase === "pending") expect(approvalSignal?.aborted).toBe(true);
      for (const child of children)
        expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
      if (phase === "initializing")
        expect((await s.read()).some((message) => message.method === "thread/start")).toBe(false);
    });
  }

  for (const runtime of ["agent", "chat"] as const) {
    for (const phase of ["before", "discovery"] as const) {
      test(`Codex ${runtime} skips spawn when cancelled ${phase}`, async () => {
        const s = await setup();
        if (phase === "before") s.abortController.abort();
        const deps = {
          findBinary: async () => {
            s.abortController.abort();
            return "fixture";
          },
          spawn: () => {
            throw new Error("must not spawn after stop");
          },
        };
        if (runtime === "agent") await runCodexAgent(s.input, deps);
        else
          await runCodexChat(
            { ...s.input, messages: [{ role: "user", content: "fixture" }] },
            deps,
          );
        expect(s.events.at(-1)?.type).toBe("done");
      });
    }
  }

  test("Codex Chat explicitly selects read-only sandbox", async () => {
    const s = await setup();
    let command: string[] = [];
    await runCodexChat(
      { ...s.input, messages: [{ role: "user", content: "fixture" }] },
      {
        findBinary: async () => "fixture",
        spawn: (args) => {
          command = args;
          return {
            stdout: new Blob([]).stream(),
            stderr: new Blob([]).stream(),
            exited: Promise.resolve(0),
          };
        },
      },
    );
    expect(command.slice(command.indexOf("--sandbox"), command.indexOf("--sandbox") + 2)).toEqual([
      "--sandbox",
      "read-only",
    ]);
  });

  test("ACP per-turn full access never leaks into reused default session", async () => {
    const s = await setup();
    let sessionId: string | undefined;
    let approvalCount = 0;
    const common = {
      ...s.input,
      agent: { command: process.execPath, args: [fixture, "acp", s.file] },
      checkpoint: {
        runId: "fixture",
        workspaceRoot: s.directory,
        checkpointDir: s.directory,
        files: new Map(),
      },
      requestApproval: async () => {
        approvalCount++;
        return false;
      },
      onSessionId: (id: string) => {
        sessionId = id;
      },
    };
    try {
      await runAcpAgent({ ...common, permissionMode: "full-access" });
      expect(approvalCount).toBe(0);
      await runAcpAgent({ ...common, acpSessionId: sessionId, permissionMode: "default" });
      expect(approvalCount).toBe(1);
      expect((await s.read()).filter((row) => row.permission).map((row) => row.permission)).toEqual(
        [
          { outcome: { outcome: "selected", optionId: "allow" } },
          { outcome: { outcome: "selected", optionId: "deny" } },
        ],
      );
    } finally {
      for (const row of await s.read()) if (typeof row.pid === "number") acpPids.add(row.pid);
    }
  });

  test("ACP Stop during initialize never submits a prompt", async () => {
    const s = await setup();
    const run = runAcpAgent({
      ...s.input,
      agent: { command: process.execPath, args: [fixture, "acp", s.file, "initializing"] },
      checkpoint: {
        runId: "fixture",
        workspaceRoot: s.directory,
        checkpointDir: s.directory,
        files: new Map(),
      },
      requestApproval: async () => false,
      onSessionId: () => {},
    });
    await waitUntil(async () => (await s.read()).some((row) => row.method === "initialize"));
    s.abortController.abort();
    await run;
    const rows = await s.read();
    for (const row of rows) if (typeof row.pid === "number") acpPids.add(row.pid);
    expect(rows.some((row) => row.method === "session/prompt")).toBe(false);
    expect(s.events.at(-1)?.type).toBe("done");
  });

  test("Direct pre-aborted run never sends a provider request", async () => {
    const s = await setup();
    let requestCount = 0;
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => {
        requestCount++;
        return new Response(
          'data: {"choices":[{"index":0,"delta":{"content":"fixture"},"finish_reason":null}]}\n\ndata: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    try {
      s.abortController.abort();
      await runDirectAgent({
        ...s.input,
        apiKey: "fixture",
        baseUrl: `http://127.0.0.1:${server.port}/v1`,
        webSearchEnabled: false,
        checkpoint: {
          runId: "fixture",
          workspaceRoot: s.directory,
          checkpointDir: s.directory,
          files: new Map(),
        },
      });
      expect(requestCount).toBe(0);
      expect(s.events.at(-1)?.type).toBe("done");
    } finally {
      await server.stop(true);
    }
  });

  test("Direct Stop while awaiting approval prevents execution after a late acceptance", async () => {
    const s = await setup();
    let approve: ((allow: boolean) => void) | undefined;
    const result = executeTool("bash", { command: "printf fixture > marker" }, s.directory, {
      signal: s.abortController.signal,
      requestApproval: () =>
        new Promise((resolve) => {
          approve = resolve;
        }),
    });
    await waitUntil(() => Boolean(approve));
    s.abortController.abort();
    approve?.(true);
    await result;
    expect(
      await access(path.join(s.directory, "marker")).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
  });

  test("Codex Stop kills subprocess descendants before they can write", async () => {
    const s = await setup();
    const run = runCodexAgent(s.input, s.dependencies("descendant"));
    await waitUntil(async () =>
      (await s.read()).some((row) => typeof row.descendantPid === "number"),
    );
    s.abortController.abort();
    await run;
    await Bun.sleep(400);
    expect(
      await access(path.join(s.directory, "marker")).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
  });

  test("ACP rejects a filesystem write requested after Stop", async () => {
    const s = await setup();
    const run = runAcpAgent({
      ...s.input,
      agent: { command: process.execPath, args: [fixture, "acp", s.file, "late-write"] },
      checkpoint: {
        runId: "fixture",
        workspaceRoot: s.directory,
        checkpointDir: s.directory,
        files: new Map(),
      },
      requestApproval: async () => false,
      onSessionId: () => {},
    });
    try {
      await waitUntil(async () => (await s.read()).some((row) => row.method === "session/prompt"));
      s.abortController.abort();
      await run;
      expect((await s.read()).find((row) => row.lateWrite)?.lateWrite).toBe("rejected");
      expect(
        await access(path.join(s.directory, "marker")).then(
          () => true,
          () => false,
        ),
      ).toBe(false);
    } finally {
      for (const row of await s.read()) if (typeof row.pid === "number") acpPids.add(row.pid);
    }
  });

  for (const tool of ["write_file", "edit_file"]) {
    test(`Direct ${tool} Stop during checkpoint backup preserves the original file`, async () => {
      const s = await setup();
      await writeFile(path.join(s.directory, "original.txt"), "original");
      const previousHome = process.env.OPENHORN_HOME;
      process.env.OPENHORN_HOME = path.join(s.directory, "state");
      try {
        const checkpoint = await createCheckpointSession(s.directory);
        const run = executeTool(
          tool,
          {
            path: "original.txt",
            content: "replaced",
            old_string: "original",
            new_string: "replaced",
          },
          s.directory,
          { signal: s.abortController.signal, checkpoint },
        );
        s.abortController.abort();
        await run;
        expect(checkpoint.files.has("original.txt")).toBe(true);
        expect(await readFile(path.join(s.directory, "original.txt"), "utf8")).toBe("original");
      } finally {
        if (previousHome === undefined) delete process.env.OPENHORN_HOME;
        else process.env.OPENHORN_HOME = previousHome;
      }
    });
  }
});
