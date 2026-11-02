import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ChatMessage } from "adapters";
import { preconnectAcpAgent, runAcpAgent } from "./acp";
import { runCodexChat } from "./chatCodex";
import { runCodexAgent } from "./codex";
import type { AgentEvent } from "./events";
import { codexChatContext, withConversationHistory, withRunInstructions } from "./runtimePrompt";
import { buildAgentSystemPrompt } from "./system-prompt";

const fixture = new URL("./runtimePrompt.fixture.ts", import.meta.url).pathname;
const instructions = 'Interactive UI instructions\nUse Button("Assess", @ToAssistant("Ask"))';
const temporaryDirectories: string[] = [];
const acpProcesses = new Set<number>();

afterEach(async () => {
  for (const pid of acpProcesses) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // The fixture may already have exited after its second request.
    }
  }
  acpProcesses.clear();
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

async function captureFixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "openhorn-runtime-prompt-"));
  temporaryDirectories.push(directory);
  const file = path.join(directory, "transport.jsonl");
  const read = async (): Promise<Array<Record<string, unknown>>> =>
    (await readFile(file, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
  return { directory, file, read };
}

describe("external runtime prompt context", () => {
  test("Codex Chat surfaces a JSON failed turn even when stderr is empty", async () => {
    const capture = await captureFixture();
    const events: AgentEvent[] = [];
    await runCodexChat(
      {
        model: "fixture",
        messages: [{ role: "user", content: "fixture" }],
        abortController: new AbortController(),
        onEvent: (event) => events.push(event),
      },
      {
        findBinary: async () => "fixture",
        spawn: (_command, options) =>
          Bun.spawn([process.execPath, fixture, "exec-failed", capture.file], options),
      },
    );
    expect(events).toContainEqual({ type: "error", content: "fixture exec failed" });
    expect(events.some((event) => event.type === "done")).toBe(false);
  });
  test("omitted instructions preserve existing prompt bytes and history formatting", () => {
    const prompt = "  preserve whitespace\n";
    expect(withRunInstructions(prompt)).toBe(prompt);
    expect(withRunInstructions(prompt, " \n")).toBe(prompt);
    expect(withConversationHistory(prompt)).toBe(prompt);
    expect(withConversationHistory("next", [{ role: "user", content: "earlier" }])).toBe(
      "User: earlier\n\n---\n\nUser: next",
    );
  });

  test("extracts all system text and keeps user/assistant history without duplicating the current turn", () => {
    const result = codexChatContext([
      { role: "system", content: "global instructions" },
      { role: "user", content: "earlier question" },
      { role: "assistant", content: "earlier answer" },
      { role: "system", content: [{ type: "text", text: instructions }] },
      { role: "user", content: [{ type: "text", text: "current question" }] },
    ]);
    expect(result.systemPrompt).toBe(`global instructions\n\n${instructions}`);
    expect(result.prompt).toBe(
      "User: earlier question\n\nAssistant: earlier answer\n\n---\n\nUser: current question",
    );
  });

  for (const extra of [undefined, instructions]) {
    test(`Codex agent submits ${extra ? "per-run" : "only existing"} developer instructions on thread/start`, async () => {
      const capture = await captureFixture();
      const events: AgentEvent[] = [];
      await runCodexAgent(
        {
          model: "fixture",
          contextWindow: 1_000_000,
          prompt: "current question",
          systemPrompt: extra,
          cwd: capture.directory,
          conversationHistory: [{ role: "assistant", content: "earlier answer" }],
          abortController: new AbortController(),
          onEvent: (event) => events.push(event),
        },
        {
          findBinary: async () => "fixture-codex",
          spawn: (_command, _args, options) =>
            spawn(process.execPath, [fixture, "agent", capture.file], options),
        },
      );
      const messages = await capture.read();
      const thread = messages.find((message) => message.method === "thread/start");
      const params = thread?.params as Record<string, unknown>;
      const base = buildAgentSystemPrompt({
        cwd: capture.directory,
        permissionMode: undefined,
        extra:
          "For simple lookups answerable by running a command or reading files (e.g. 'how many images in my Downloads'), act first — run `ls`/`find` immediately and report the result rather than listing options.",
      });
      expect(params.developerInstructions).toBe(extra ? `${base}\n\n${extra}` : base);
      expect(params.config).toMatchObject({ model_context_window: 1_000_000 });
      const turn = messages.find((message) => message.method === "turn/start");
      expect((turn?.params as Record<string, unknown>).input).toEqual([
        { type: "text", text: "Assistant: earlier answer\n\n---\n\nUser: current question" },
      ]);
      expect(
        events.some((event) => event.type === "text" && event.content === "fixture response"),
      ).toBe(true);
      expect(events.at(-1)?.type).toBe("done");
    });

    test(`Codex chat exec ${extra ? "passes multi-line instructions as one config argument" : "omits the optional instruction argument"}`, async () => {
      const capture = await captureFixture();
      const messages: ChatMessage[] = [
        ...(extra ? [{ role: "system" as const, content: extra }] : []),
        { role: "user", content: "earlier question" },
        { role: "assistant", content: "earlier answer" },
        { role: "user", content: "current question" },
      ];
      const events: AgentEvent[] = [];
      await runCodexChat(
        {
          model: "fixture",
          messages,
          abortController: new AbortController(),
          onEvent: (event) => events.push(event),
        },
        {
          findBinary: async () => "fixture-codex",
          spawn: (command, options) =>
            Bun.spawn(
              [process.execPath, fixture, "exec", capture.file, JSON.stringify(command)],
              options,
            ),
        },
      );
      const command = (await capture.read()).find((entry) => Array.isArray(entry.command))
        ?.command as string[];
      expect(command[2]).toBe("-");
      const stdin = (await capture.read()).find((entry) => typeof entry.stdin === "string")?.stdin;
      expect(stdin).toBe(
        "User: earlier question\n\nAssistant: earlier answer\n\n---\n\nUser: current question",
      );
      expect(command.filter((argument) => argument.startsWith("developer_instructions="))).toEqual(
        extra ? [`developer_instructions=${JSON.stringify(extra)}`] : [],
      );
      expect(events.at(-1)?.type).toBe("done");
      expect(
        events.some((event) => event.type === "text" && event.content === "fixture response"),
      ).toBe(true);
    });
  }

  test("ACP sends per-request instructions through real session/prompt and does not carry them into the next request", async () => {
    const capture = await captureFixture();
    let sessionId: string | undefined;
    const events: AgentEvent[] = [];
    const common = {
      agent: { command: process.execPath, args: [fixture, "acp", capture.file] },
      cwd: capture.directory,
      checkpoint: {
        runId: "fixture-run",
        workspaceRoot: capture.directory,
        checkpointDir: capture.directory,
        files: new Map(),
      },
      requestApproval: async () => false,
      onSessionId: (id: string) => {
        sessionId = id;
      },
      onEvent: (event: AgentEvent) => events.push(event),
    };
    try {
      await runAcpAgent({
        ...common,
        prompt: "first question",
        systemPrompt: instructions,
        conversationHistory: [{ role: "assistant", content: "earlier answer" }],
        abortController: new AbortController(),
      });
      const pid = (await capture.read()).find((entry) => typeof entry.pid === "number")?.pid;
      if (typeof pid === "number") acpProcesses.add(pid);
      await runAcpAgent({
        ...common,
        prompt: "  second question\n",
        acpSessionId: sessionId,
        abortController: new AbortController(),
      });
      const requests = (await capture.read()).filter((entry) => entry.method === "session/prompt");
      expect(requests.length).toBe(2);
      const prompts = requests.map(
        (entry) => (entry.params as { prompt: Array<{ text: string }> }).prompt[0]?.text,
      );
      expect(prompts[0]).toBe(
        `[OpenHorn app instructions for this request only]\n${instructions}\n[End app instructions]\n\n[User request and conversation context]\nAssistant: earlier answer\n\n---\n\nUser: first question\n[End user request]`,
      );
      expect(prompts[1]).toBe("  second question\n");
      expect(events.filter((event) => event.type === "done").length).toBe(2);
      expect(events.filter((event) => event.type === "error")).toEqual([]);
    } finally {
      // Capture the pid even if the first prompt failed after the process started.
      const pid = (await capture.read()).find((entry) => typeof entry.pid === "number")?.pid;
      if (typeof pid === "number") acpProcesses.add(pid);
    }
  }, 15000);

  test("ACP rejects a preconnected session from another workspace and starts in this run's cwd", async () => {
    const capture = await captureFixture();
    const firstRoot = await realpath(capture.directory);
    await mkdir(path.join(capture.directory, "other-project"));
    const secondRoot = await realpath(path.join(capture.directory, "other-project"));
    const agent = { command: process.execPath, args: [fixture, "acp", capture.file] };
    const events: AgentEvent[] = [];
    try {
      const preconnected = await preconnectAcpAgent({ agent, cwd: firstRoot });
      await runAcpAgent({
        agent,
        cwd: secondRoot,
        acpSessionId: preconnected.sessionId,
        prompt: "local workspace fixture",
        abortController: new AbortController(),
        checkpoint: {
          runId: "workspace-fixture",
          workspaceRoot: secondRoot,
          checkpointDir: capture.directory,
          files: new Map(),
        },
        requestApproval: async () => false,
        onSessionId: () => {},
        onEvent: (event) => events.push(event),
      });
      const records = await capture.read();
      const processes = records.filter((entry) => typeof entry.pid === "number");
      expect(processes.map((entry) => entry.cwd)).toEqual([firstRoot, secondRoot]);
      expect(new Set(processes.map((entry) => entry.pid)).size).toBe(2);
      expect(records.filter((entry) => entry.method === "session/prompt").length).toBe(1);
      expect(events.some((event) => event.type === "error")).toBe(false);
      expect(events.at(-1)?.type).toBe("done");
    } finally {
      for (const record of await capture.read()) {
        if (typeof record.pid === "number") acpProcesses.add(record.pid);
      }
    }
  }, 15000);
});

test("Codex exec sends large user/history bytes through stdin with per-run capacity metadata", async () => {
  const capture = await captureFixture();
  const history = [
    { role: "user" as const, content: `HISTORY-BEGIN${"h".repeat(90_000)}HISTORY-END` },
    { role: "assistant" as const, content: "previous reply" },
  ];
  const current = `CURRENT-BEGIN${"c".repeat(300_000)}CURRENT-END`;
  await runCodexChat(
    {
      model: "gpt-6-astra",
      messages: [...history, { role: "user", content: current }],
      abortController: new AbortController(),
      onEvent: () => {},
    },
    {
      findBinary: async () => "fixture-codex",
      spawn: (command, options) =>
        Bun.spawn(
          [process.execPath, fixture, "exec", capture.file, JSON.stringify(command)],
          options,
        ),
    },
  );
  const record = (await capture.read()).find((entry) => typeof entry.stdin === "string");
  const command = record?.command as string[];
  expect(command[2]).toBe("-");
  expect(command).toContain("model_context_window=1050000");
  expect(command.join(" ").length < 1000).toBe(true);
  expect(record?.stdin).toBe(
    `User: ${history[0].content}\n\nAssistant: previous reply\n\n---\n\nUser: ${current}`,
  );
});

test("Codex exec refuses oversized encoded developer instructions before binary discovery", async () => {
  const events: AgentEvent[] = [];
  let discovered = false;
  await runCodexChat(
    {
      model: "gpt-6-astra",
      messages: [
        { role: "system", content: "x".repeat(70_000) },
        { role: "user", content: "q" },
      ],
      abortController: new AbortController(),
      onEvent: (event) => events.push(event),
    },
    {
      findBinary: async () => {
        discovered = true;
        return null;
      },
    },
  );
  expect(discovered).toBe(false);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ type: "error" });
  expect(JSON.stringify(events)).toContain("64 KiB");
});

test("discovered non-GPT capacity and input ceilings reach native Codex process/thread config", async () => {
  const capture = await captureFixture();
  const contextMetadata = {
    contextWindow: 262_144,
    maxInputTokens: 200_000,
    maxOutputTokens: 1_024,
    source: "runtime" as const,
    fetchedAt: 1_793_600_000_000,
  };
  let processArgs: string[] = [];
  await runCodexAgent(
    {
      model: "dynamic-non-gpt",
      contextMetadata,
      prompt: "current",
      cwd: capture.directory,
      abortController: new AbortController(),
      onEvent: () => {},
    },
    {
      findBinary: async () => "fixture-codex",
      spawn: (_command, args, options) => {
        processArgs = args;
        return spawn(process.execPath, [fixture, "agent", capture.file], options);
      },
    },
  );
  expect(processArgs).toContain("model_context_window=262144");
  expect(processArgs).toContain("model_auto_compact_token_limit=200000");
  const thread = (await capture.read()).find((record) => record.method === "thread/start");
  expect((thread?.params as Record<string, unknown>).config).toEqual({
    model_context_window: 262_144,
    model_auto_compact_token_limit: 200_000,
  });
});

test("discovered non-GPT capacity reaches native Codex Chat exec config without fallback clipping", async () => {
  const capture = await captureFixture();
  const contextMetadata = {
    contextWindow: 262_144,
    maxInputTokens: 200_000,
    maxOutputTokens: 1_024,
    source: "channel" as const,
    fetchedAt: 1_793_600_000_000,
  };
  const prompt = `BEGIN${"x".repeat(200_000)}END`;
  await runCodexChat(
    {
      model: "dynamic-non-gpt",
      contextMetadata,
      messages: [{ role: "user", content: prompt }],
      abortController: new AbortController(),
      onEvent: () => {},
    },
    {
      findBinary: async () => "fixture-codex",
      spawn: (command, options) =>
        Bun.spawn(
          [process.execPath, fixture, "exec", capture.file, JSON.stringify(command)],
          options,
        ),
    },
  );
  const record = (await capture.read()).find((entry) => typeof entry.stdin === "string");
  expect(record?.command as string[]).toContain("model_context_window=262144");
  expect(record?.command as string[]).toContain("model_auto_compact_token_limit=200000");
  expect(record?.stdin).toBe(prompt);
});
