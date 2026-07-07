import { type ChildProcess, spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { AttachmentPart } from "shared/types";
import { appendAttachmentContext } from "./attachments";
import { sanitizeChildEnv } from "./childEnv";
import type { AgentEvent } from "./events";
import { buildAgentSystemPrompt } from "./system-prompt";

export type RunCodexAgentInput = {
  model: string;
  prompt: string;
  cwd: string;
  abortController: AbortController;
  attachments?: AttachmentPart[];
  onEvent: (event: AgentEvent) => void;
};

// How long to wait after SIGTERM before escalating to SIGKILL. Codex runs with
// danger-full-access, so a child that ignores the graceful signal must not be
// allowed to linger with full filesystem access.
const SIGKILL_ESCALATION_MS = 4000;

type JsonRpcMessage = {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { message?: string; code?: number };
};

function send(proc: ChildProcess, msg: Record<string, unknown>) {
  proc.stdin?.write(`${JSON.stringify(msg)}\n`);
}

function sendRequest(proc: ChildProcess, id: number, method: string, params?: unknown) {
  send(proc, { method, id, ...(params ? { params } : {}) });
}

function sendNotification(proc: ChildProcess, method: string, params?: unknown) {
  send(proc, { method, ...(params ? { params } : {}) });
}

/**
 * Builds the env for the codex child process. Codex runs with
 * `sandbox_mode="danger-full-access"` and `approval_policy="never"`, so a
 * prompt-injected codex agent has a full shell. It must NOT inherit our
 * handshake token or unrelated service credentials (a `printenv` would leak
 * them). Codex authenticates via its own `~/.codex` config (keyed off HOME),
 * so stripping these does not break it. Mirrors the env hygiene in claude.ts.
 */
function buildCodexEnv(): NodeJS.ProcessEnv {
  return sanitizeChildEnv({ ...process.env });
}

function mapCodexEvent(msg: JsonRpcMessage): AgentEvent | null {
  const method = msg.method;
  if (!method) return null;
  const params = (msg.params ?? {}) as Record<string, unknown>;

  if (method === "item/agentMessage/delta") {
    const delta = typeof params.delta === "string" ? params.delta : "";
    if (delta) return { type: "text", content: delta };
  }

  if (method === "item/started") {
    const item = (params.item ?? {}) as Record<string, unknown>;
    const itemType = typeof item.type === "string" ? item.type : "";
    if (itemType === "commandExecution") {
      const call = (item.call ?? item) as Record<string, unknown>;
      return {
        type: "tool_start",
        toolName: "shell",
        toolInput: typeof call.command === "string" ? { command: call.command } : undefined,
      };
    }
    if (itemType === "fileChange") {
      return {
        type: "tool_start",
        toolName: "file_edit",
        toolInput: typeof item.filePath === "string" ? { file_path: item.filePath } : undefined,
      };
    }
  }

  if (method === "item/commandExecution/outputDelta") {
    return null;
  }

  if (method === "item/completed") {
    const item = (params.item ?? {}) as Record<string, unknown>;
    const itemType = typeof item.type === "string" ? item.type : "";
    if (itemType === "commandExecution" || itemType === "fileChange") {
      const output = typeof item.output === "string" ? item.output : undefined;
      return { type: "tool_result", content: output };
    }
  }

  if (method === "turn/completed") {
    const status = typeof params.status === "string" ? params.status : "";
    if (status === "failed") {
      const err = (params.error ?? {}) as Record<string, unknown>;
      const message = typeof err.message === "string" ? err.message : "Codex turn failed";
      return { type: "error", content: message };
    }
    return { type: "done" };
  }

  return null;
}

export async function runCodexAgent(input: RunCodexAgentInput): Promise<void> {
  const { model, cwd, abortController, onEvent } = input;
  // Inject attachment context (file text now; image placeholders until phase B).
  const prompt = appendAttachmentContext(input.prompt, input.attachments);
  // Do not log prompt content (user data); a length marker is enough.
  console.error(`[codex-agent] starting: model=${model} cwd=${cwd} promptLen=${prompt.length}`);

  const codexPath = await findCodexBinary();
  console.error(`[codex-agent] codexPath=${codexPath}`);
  if (!codexPath) {
    onEvent({ type: "error", content: "Codex CLI 未安装。请先安装：npm i -g @openai/codex" });
    onEvent({ type: "done" });
    return;
  }

  const proc = spawn(
    codexPath,
    [
      "app-server",
      "--listen",
      "stdio://",
      "-c",
      'approval_policy="never"',
      "-c",
      'sandbox_mode="danger-full-access"',
    ],
    {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: buildCodexEnv(),
    },
  );

  // Track child liveness so teardown can (a) escalate SIGTERM→SIGKILL for a
  // full-access child that ignores the graceful signal, and (b) resolve only
  // once the process has actually exited, never leaving an orphan behind.
  let procClosed = false;
  let killTimer: ReturnType<typeof setTimeout> | null = null;
  let markClosed: () => void = () => {};
  const closedPromise = new Promise<void>((res) => {
    markClosed = res;
  });
  const settleClosed = () => {
    procClosed = true;
    if (killTimer) {
      clearTimeout(killTimer);
      killTimer = null;
    }
    markClosed();
  };

  const cleanup = () => {
    try {
      proc.kill("SIGTERM");
    } catch {
      // already dead
    }
    // If the child (or a shell it spawned) ignores SIGTERM, force-kill it so a
    // full-access process can't outlive the run.
    if (!killTimer && !procClosed) {
      killTimer = setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {
          // already dead
        }
      }, SIGKILL_ESCALATION_MS);
      killTimer.unref?.();
    }
  };

  if (abortController.signal.aborted) {
    cleanup();
    onEvent({ type: "error", content: "已取消" });
    onEvent({ type: "done" });
    return;
  }

  abortController.signal.addEventListener("abort", cleanup, { once: true });

  return new Promise<void>((resolve) => {
    let nextId = 0;
    let threadId = "";
    let threadStarted = false;
    let done = false;
    let resolved = false;
    let pendingText = "";

    const settle = () => {
      if (resolved) return;
      resolved = true;
      resolve();
    };

    const finish = async (event?: AgentEvent) => {
      if (done) return;
      done = true;
      if (pendingText) {
        const chars = Array.from(pendingText);
        const chunkSize = 8;
        for (let i = 0; i < chars.length; i += chunkSize) {
          onEvent({ type: "final_text", content: chars.slice(i, i + chunkSize).join("") });
          if (i + chunkSize < chars.length) {
            await new Promise((r) => setTimeout(r, 15));
          }
        }
        pendingText = "";
      }
      if (event) onEvent(event);
      onEvent({ type: "done" });
      cleanup();
      // Resolve only after the child has actually exited so teardown never
      // leaves an orphaned full-access process. `settleClosed()` (fired from the
      // 'close'/'error' handlers) unblocks this await.
      await closedPromise;
      settle();
    };

    const pendingResponses = new Map<number, (msg: JsonRpcMessage) => void>();

    function sendReq(method: string, params?: unknown): Promise<JsonRpcMessage> {
      const id = nextId++;
      return new Promise((res) => {
        pendingResponses.set(id, res);
        sendRequest(proc, id, method, params);
      });
    }

    const rl = createInterface({ input: proc.stdout!, crlfDelay: Number.POSITIVE_INFINITY });

    rl.on("line", (line) => {
      if (!line.trim()) return;
      let msg: JsonRpcMessage;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }

      if (typeof msg.id === "number" && pendingResponses.has(msg.id)) {
        const handler = pendingResponses.get(msg.id)!;
        pendingResponses.delete(msg.id);
        handler(msg);
        return;
      }

      if (typeof msg.id === "number" && msg.method) {
        send(proc, { id: msg.id, result: { decision: "accept" } });
        return;
      }

      if (msg.method === "turn/started") {
        threadStarted = true;
      }
      const event = mapCodexEvent(msg);
      if (event) {
        if ((event.type === "done" || event.type === "error") && threadStarted) {
          finish(event.type === "error" ? event : undefined);
          return;
        }
        if (event.type === "text") {
          pendingText += event.content;
        } else if (event.type === "tool_start") {
          if (pendingText) {
            onEvent({ type: "thinking", content: pendingText });
          }
          pendingText = "";
          onEvent(event);
        } else if (event.type !== "done") {
          onEvent(event);
        }
      }
    });

    proc.on("error", (err) => {
      // A spawn error may mean no 'close' will ever fire — unblock finish's await.
      settleClosed();
      finish({ type: "error", content: err.message });
    });

    proc.on("close", (code) => {
      settleClosed();
      if (!done) {
        if (code && code !== 0) {
          finish({ type: "error", content: `Codex 进程退出，代码: ${code}` });
        } else {
          finish();
        }
      } else {
        // finish already ran; its await on closedPromise is now unblocked, but
        // settle here too in case it had already passed that point.
        settle();
      }
    });

    (async () => {
      try {
        const initResp = await sendReq("initialize", {
          clientInfo: { name: "openhorn", title: "OpenHorn Agent", version: "1.0.0" },
          capabilities: {},
        });
        if (initResp.error) {
          finish({ type: "error", content: `Codex 初始化失败: ${initResp.error.message}` });
          return;
        }
        sendNotification(proc, "initialized");

        const threadResp = await sendReq("thread/start", {
          model,
          cwd,
          approvalPolicy: "never",
          sandbox: "danger-full-access",
          developerInstructions: buildAgentSystemPrompt({
            cwd,
            permissionMode: "full-access",
            extra:
              "For simple lookups answerable by running a command or reading files (e.g. 'how many images in my Downloads'), act first — run `ls`/`find` immediately and report the result rather than listing options.",
          }),
        });
        if (threadResp.error) {
          finish({ type: "error", content: `Codex thread 创建失败: ${threadResp.error.message}` });
          return;
        }
        const threadResult = threadResp.result as Record<string, unknown> | undefined;
        const thread = (threadResult?.thread ?? {}) as Record<string, unknown>;
        threadId = typeof thread.id === "string" ? thread.id : "";
        if (!threadId) {
          finish({ type: "error", content: "Codex 未返回 thread ID" });
          return;
        }
        threadStarted = true;

        const turnResp = await sendReq("turn/start", {
          threadId,
          input: [{ type: "text", text: prompt }],
          model,
        });
        if (turnResp.error) {
          finish({ type: "error", content: `Codex turn 启动失败: ${turnResp.error.message}` });
          return;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : "Codex 启动失败";
        finish({ type: "error", content: message });
      }
    })();
  });
}

async function findCodexBinary(): Promise<string | null> {
  const { existsSync: fsExists } = await import("node:fs");
  for (const p of [
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex",
    join(homedir(), ".local/bin/codex"),
  ]) {
    if (fsExists(p)) return p;
  }
  const { execSync } = await import("node:child_process");
  try {
    const path = execSync("which codex", {
      timeout: 5000,
      env: { ...process.env, PATH: `${process.env.PATH}:/opt/homebrew/bin:/usr/local/bin` },
    })
      .toString()
      .trim();
    return path || null;
  } catch {
    return null;
  }
}
