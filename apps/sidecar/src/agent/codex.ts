import { type ChildProcess, type SpawnOptions, spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { resolveContextPolicy } from "shared/context-policy";
import type { AttachmentPart } from "shared/types";
import { appendAttachmentContext } from "./attachments";
import { sanitizeChildEnv } from "./childEnv";
import { type AgentEvent, buildUsageEvent, toCount } from "./events";
import { withConversationHistory } from "./runtimePrompt";
import { buildAgentSystemPrompt } from "./system-prompt";

export type RunCodexAgentInput = {
  model: string;
  contextWindow?: number | null;
  prompt: string;
  systemPrompt?: string;
  cwd: string;
  abortController: AbortController;
  attachments?: AttachmentPart[];
  conversationHistory?: Array<{ role: "user" | "assistant"; content: string }>;
  permissionMode?: "default" | "full-access";
  requestApproval?: (
    input: {
      toolUseId: string;
      toolName: string;
      toolInput: Record<string, unknown>;
      decisionReason?: string;
    },
    signal: AbortSignal,
  ) => Promise<boolean>;
  onEvent: (event: AgentEvent) => void;
};

// How long to wait after SIGTERM before escalating to SIGKILL. Codex runs with
// danger-full-access, so a child that ignores the graceful signal must not be
// allowed to linger with full filesystem access.
const SIGKILL_ESCALATION_MS = 4000;

type JsonRpcMessage = {
  id?: number | string;
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
 * Builds the env for the codex child process. Explicit full access permits a
 * full shell, so the process must NOT inherit our
 * handshake token or unrelated service credentials (a `printenv` would leak
 * them). Codex authenticates via its own `~/.codex` config (keyed off HOME),
 * so stripping these does not break it. Mirrors the env hygiene in claude.ts.
 */
function buildCodexEnv(): NodeJS.ProcessEnv {
  return sanitizeChildEnv({ ...process.env });
}

/**
 * Token counts out of a `thread/tokenUsage/updated` notification, or null for
 * any other message.
 *
 * Shape verified against codex-cli 0.145.0:
 *   { threadId, turnId, tokenUsage: { total: {...}, last: {...},
 *                                     modelContextWindow } }
 * where each bucket is `{ totalTokens, inputTokens, cachedInputTokens,
 * cacheWriteInputTokens, outputTokens, reasoningOutputTokens }`.
 *
 * Reads `total`, not `last`: a run opens its own thread, so `total` is exactly
 * this run and already spans the agent's internal steps. `last` would report
 * only the final one.
 *
 * `cachedInputTokens` is deliberately NOT added — it is a subset of
 * `inputTokens`, not a sibling bucket (the probe showed
 * totalTokens === inputTokens + outputTokens while cachedInputTokens was 4480).
 * Codex differs from Anthropic here, and adding it would inflate every cached
 * turn.
 */
export function readCodexUsage(
  msg: JsonRpcMessage,
): { promptTokens: number; completionTokens: number } | null {
  if (msg.method !== "thread/tokenUsage/updated") return null;
  const params = (msg.params ?? {}) as Record<string, unknown>;
  const tokenUsage = (params.tokenUsage ?? {}) as Record<string, unknown>;
  const total = (tokenUsage.total ?? {}) as Record<string, unknown>;
  return {
    promptTokens: toCount(total.inputTokens),
    completionTokens: toCount(total.outputTokens),
  };
}

/** Exported for tests: maps a codex app-server JSON-RPC message to an AgentEvent. */
export function mapCodexEvent(msg: JsonRpcMessage): AgentEvent | null {
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
    // Current app-server nests status/error under turn. Keep the old flat
    // payload working for older installed CLIs.
    const turn = (params.turn ?? params) as Record<string, unknown>;
    const status = typeof turn.status === "string" ? turn.status : "";
    if (status === "failed") {
      const err = (turn.error ?? {}) as Record<string, unknown>;
      const message = typeof err.message === "string" ? err.message : "Codex turn failed";
      return { type: "error", content: message };
    }
    if (status === "interrupted") return { type: "error", content: "Codex turn interrupted" };
    return { type: "done" };
  }

  return null;
}

type CodexAgentDependencies = {
  findBinary: typeof findCodexBinary;
  spawn: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
};

export async function runCodexAgent(
  input: RunCodexAgentInput,
  dependencies: Partial<CodexAgentDependencies> = {},
): Promise<void> {
  const { model, cwd, abortController, onEvent } = input;
  if (abortController.signal.aborted) {
    onEvent({ type: "done" });
    return;
  }
  const policy = resolveContextPolicy({ ...input, protocol: "codex_cli", mode: "agent" });
  const developerInstructions = [
    buildAgentSystemPrompt({
      cwd,
      permissionMode: input.permissionMode,
      extra:
        "For simple lookups answerable by running a command or reading files (e.g. 'how many images in my Downloads'), act first — run `ls`/`find` immediately and report the result rather than listing options.",
    }),
    input.systemPrompt?.trim(),
  ]
    .filter(Boolean)
    .join("\n\n");
  const prompt = withConversationHistory(
    appendAttachmentContext(input.prompt, input.attachments),
    input.conversationHistory,
    { ...input, protocol: "codex_cli", systemPrompt: developerInstructions },
  );
  const codexPath = await (dependencies.findBinary ?? findCodexBinary)();
  // Stop can arrive while discovering the binary, before a subprocess exists.
  if (abortController.signal.aborted) {
    onEvent({ type: "done" });
    return;
  }
  if (!codexPath) {
    onEvent({ type: "error", content: "Codex CLI 未安装。请先安装：npm i -g @openai/codex" });
    onEvent({ type: "done" });
    return;
  }

  const fullAccess = input.permissionMode === "full-access";
  const approvalPolicy = fullAccess ? "never" : "untrusted";
  const sandbox = fullAccess ? "danger-full-access" : "workspace-write";
  const proc = (dependencies.spawn ?? spawn)(
    codexPath,
    [
      "app-server",
      "--listen",
      "stdio://",
      "-c",
      `approval_policy=${JSON.stringify(approvalPolicy)}`,
      "-c",
      `sandbox_mode=${JSON.stringify(sandbox)}`,
      "-c",
      `model_context_window=${policy.contextWindow}`,
      "-c",
      `model_auto_compact_token_limit=${policy.maxInputTokens}`,
    ],
    {
      cwd,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
      env: buildCodexEnv(),
    },
  );
  // Drain diagnostics immediately; a full stderr pipe can otherwise deadlock
  // the child while the client is waiting for its next JSON-RPC response.
  proc.stderr?.resume();

  return new Promise<void>((resolve) => {
    let nextId = 0;
    let done = false;
    let procClosed = false;
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    let usagePromptTokens = 0;
    let usageCompletionTokens = 0;
    const approvals = new AbortController();
    const pendingResponses = new Map<number, (msg: JsonRpcMessage) => void>();
    const pendingApprovals = new Map<string | number, () => void>();
    let markClosed: () => void = () => {};
    const closedPromise = new Promise<void>((res) => {
      markClosed = res;
    });
    const killChild = (signal: NodeJS.Signals) => {
      try {
        if (proc.pid && process.platform !== "win32") process.kill(-proc.pid, signal);
        else proc.kill(signal);
      } catch {
        /* Already dead. */
      }
    };
    const settleClosed = () => {
      // The app-server can exit before descendants finish handling SIGTERM.
      // Its process group remains owned even after the leader exits.
      killChild("SIGKILL");
      procClosed = true;
      if (killTimer) clearTimeout(killTimer);
      markClosed();
    };
    const cleanup = () => {
      if (procClosed) return;
      killChild("SIGTERM");
      killTimer = setTimeout(() => {
        killChild("SIGKILL");
      }, SIGKILL_ESCALATION_MS);
      killTimer.unref?.();
    };
    const finish = async (event?: AgentEvent) => {
      if (done) return;
      done = true;
      abortController.signal.removeEventListener("abort", handleAbort);
      // Answer protocol requests before killing the transport. The same signal
      // removes host approval entries; late UI acceptance cannot resume a run.
      for (const cancel of pendingApprovals.values()) cancel();
      pendingApprovals.clear();
      approvals.abort();
      for (const respond of pendingResponses.values()) {
        respond({ error: { code: -32800, message: "Codex run ended" } });
      }
      pendingResponses.clear();
      if (event) onEvent(event);
      const usage = buildUsageEvent(usagePromptTokens, usageCompletionTokens);
      if (usage) onEvent(usage);
      onEvent({ type: "done" });
      cleanup();
      await closedPromise;
      rl?.close();
      resolve();
    };
    const handleAbort = () => {
      void finish();
    };
    function sendReq(method: string, params?: unknown): Promise<JsonRpcMessage> {
      if (done) return Promise.resolve({ error: { code: -32800, message: "Codex run ended" } });
      const id = nextId++;
      return new Promise((res) => {
        pendingResponses.set(id, res);
        sendRequest(proc, id, method, params);
      });
    }

    const handleServerRequest = (msg: JsonRpcMessage & { id: string | number }) => {
      const isCommand = msg.method === "item/commandExecution/requestApproval";
      const isFile = msg.method === "item/fileChange/requestApproval";
      if (!isCommand && !isFile) {
        send(proc, {
          id: msg.id,
          error: { code: -32601, message: `Unsupported Codex request: ${msg.method}` },
        });
        return;
      }
      if (done || abortController.signal.aborted) {
        send(proc, { id: msg.id, result: { decision: "cancel" } });
        return;
      }
      if (fullAccess) {
        send(proc, { id: msg.id, result: { decision: "accept" } });
        return;
      }
      const params = msg.params ?? {};
      let answered = false;
      const respond = (decision: "accept" | "decline" | "cancel") => {
        if (answered) return;
        answered = true;
        pendingApprovals.delete(msg.id);
        if (!procClosed) send(proc, { id: msg.id, result: { decision } });
      };
      pendingApprovals.set(msg.id, () => respond("cancel"));
      void Promise.resolve()
        .then(() => {
          if (approvals.signal.aborted) return false;
          return (
            input.requestApproval?.(
              {
                toolUseId: typeof params.itemId === "string" ? params.itemId : String(msg.id),
                toolName: isCommand ? "shell" : "file_edit",
                toolInput: { ...params },
                decisionReason: typeof params.reason === "string" ? params.reason : undefined,
              },
              approvals.signal,
            ) ?? false
          );
        })
        .then(
          (allow) => respond(approvals.signal.aborted ? "cancel" : allow ? "accept" : "decline"),
          () => respond("cancel"),
        );
    };

    const rl = proc.stdout
      ? createInterface({ input: proc.stdout, crlfDelay: Number.POSITIVE_INFINITY })
      : null;
    rl?.on("line", (line) => {
      if (!line.trim() || done) return;
      let msg: JsonRpcMessage;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (!msg || typeof msg !== "object") return;
      // Requests from the child have their own id namespace. Dispatch method
      // requests first, including string ids, before looking up our responses.
      if ((typeof msg.id === "number" || typeof msg.id === "string") && msg.method) {
        handleServerRequest({ ...msg, id: msg.id });
        return;
      }
      if (typeof msg.id === "number") {
        const handler = pendingResponses.get(msg.id);
        if (handler) {
          pendingResponses.delete(msg.id);
          handler(msg);
        }
        return;
      }
      const usage = readCodexUsage(msg);
      if (usage) {
        usagePromptTokens = usage.promptTokens;
        usageCompletionTokens = usage.completionTokens;
        return;
      }
      const event = mapCodexEvent(msg);
      if (!event) return;
      if (event.type === "done" || event.type === "error") {
        void finish(event.type === "error" ? event : undefined);
      } else onEvent(event);
    });
    proc.on("error", (err) => {
      settleClosed();
      void finish({ type: "error", content: err.message });
    });
    proc.on("close", (code) => {
      settleClosed();
      void finish(
        code && code !== 0
          ? { type: "error", content: `Codex 进程退出，代码: ${code}` }
          : undefined,
      );
    });
    abortController.signal.addEventListener("abort", handleAbort, { once: true });
    if (abortController.signal.aborted) {
      handleAbort();
      return;
    }
    if (!rl) {
      void finish({ type: "error", content: "Codex process was spawned without stdout" });
      return;
    }

    void (async () => {
      try {
        const initResp = await sendReq("initialize", {
          clientInfo: { name: "openhorn", title: "OpenHorn Agent", version: "1.0.0" },
          capabilities: {},
        });
        if (done) return;
        if (initResp.error) {
          void finish({ type: "error", content: `Codex 初始化失败: ${initResp.error.message}` });
          return;
        }
        sendNotification(proc, "initialized");
        const threadResp = await sendReq("thread/start", {
          model,
          cwd,
          approvalPolicy,
          sandbox,
          developerInstructions,
          config: {
            model_context_window: policy.contextWindow,
            model_auto_compact_token_limit: policy.maxInputTokens,
          },
        });
        if (done) return;
        if (threadResp.error) {
          void finish({
            type: "error",
            content: `Codex thread 创建失败: ${threadResp.error.message}`,
          });
          return;
        }
        const threadResult = threadResp.result as Record<string, unknown> | undefined;
        const thread = (threadResult?.thread ?? {}) as Record<string, unknown>;
        const threadId = typeof thread.id === "string" ? thread.id : "";
        if (!threadId) {
          void finish({ type: "error", content: "Codex 未返回 thread ID" });
          return;
        }
        const turnResp = await sendReq("turn/start", {
          threadId,
          input: [{ type: "text", text: prompt }],
          model,
        });
        if (!done && turnResp.error)
          void finish({ type: "error", content: `Codex turn 启动失败: ${turnResp.error.message}` });
      } catch (err) {
        void finish({
          type: "error",
          content: err instanceof Error ? err.message : "Codex 启动失败",
        });
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
