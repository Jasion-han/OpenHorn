// Synthetic Anthropic protocol only; no provider or real model is contacted.
import { mock } from "bun:test";
import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentEvent } from "./events";

const [cwd, scenario] = process.argv.slice(2);
const controller = new AbortController();
const checkpoints = await import("../checkpoints");
const realCheckpoints = { ...checkpoints };
let streams = 0;
const command =
  scenario === "running"
    ? "printf started > started; sleep 0.3; printf escaped > marker"
    : "printf escaped > marker";
mock.module("@anthropic-ai/sdk", () => ({
  default: class {
    messages = {
      stream: () => {
        streams++;
        const stream = {
          on: () => stream,
          finalMessage: async () => ({
            content:
              streams === 1
                ? [
                    scenario === "backup"
                      ? {
                          type: "tool_use",
                          id: "fixture-write",
                          name: "Write",
                          input: { file_path: path.join(cwd, "marker"), content: "escaped" },
                        }
                      : {
                          type: "tool_use",
                          id: "fixture-bash",
                          name: "Bash",
                          input: { command },
                        },
                  ]
                : [{ type: "text", text: "fixture complete" }],
            usage: { input_tokens: 1, output_tokens: 1 },
            stop_reason: streams === 1 ? "tool_use" : "end_turn",
          }),
        };
        return stream;
      },
    };
  },
}));
if (scenario === "backup") {
  mock.module("../checkpoints", () => ({
    ...realCheckpoints,
    ensureCheckpointBackup: async (
      ...args: Parameters<typeof checkpoints.ensureCheckpointBackup>
    ) => {
      await realCheckpoints.ensureCheckpointBackup(...args);
      controller.abort();
    },
  }));
}
const { runClaudeAgent } = await import("./claude");
const checkpoint = await realCheckpoints.createCheckpointSession(cwd);
const events: AgentEvent[] = [];
let approve: ((value: boolean) => void) | undefined;
let approvalStarted!: () => void;
const waiting = new Promise<void>((resolve) => {
  approvalStarted = resolve;
});
if (scenario === "pre-aborted") controller.abort();
let rejected = false;
const running = runClaudeAgent({
  apiKey: "synthetic-only",
  model: "fixture",
  prompt: "fixture cancellation",
  cwd,
  checkpoint,
  permissionMode: scenario === "approval" ? "default" : "full-access",
  webSearchEnabled: false,
  abortController: controller,
  requestApproval: async () => {
    approvalStarted();
    return new Promise<boolean>((resolve) => {
      approve = resolve;
    });
  },
  onEvent: (event) => events.push(event),
  onCheckpointReady: () => {},
  onSdkSessionId: () => {},
}).catch(() => {
  rejected = true;
});
if (scenario === "approval") {
  await waiting;
  controller.abort();
  approve?.(true);
} else if (scenario === "running") {
  const deadline = Date.now() + 3000;
  while (
    !(await access(path.join(cwd, "started")).then(
      () => true,
      () => false,
    ))
  ) {
    if (Date.now() > deadline) throw new Error("Synthetic shell did not start");
    await Bun.sleep(5);
  }
  controller.abort();
}
await running;
const marker = await readFile(path.join(cwd, "marker"), "utf8").catch(() => null);
await writeFile(path.join(cwd, "result.json"), JSON.stringify({ marker, streams, rejected }));
