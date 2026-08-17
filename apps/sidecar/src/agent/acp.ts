import { type ChildProcess, spawn } from "node:child_process";
import { homedir } from "node:os";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import type { AttachmentPart } from "shared/types";
import { type CheckpointSession, ensureCheckpointBackup, finalizeCheckpoint } from "../checkpoints";
import { classifyBashCommandRisk } from "../shell-risk";
import { toWorkspaceRelative } from "../workspace";
import { appendAttachmentContext } from "./attachments";
import { sanitizeChildEnv } from "./childEnv";
import {
  type AgentEvent,
  type AgentToolDiff,
  type AgentToolLocation,
  buildUsageEvent,
  toCount,
} from "./events";

/** A model option from the ACP session's config options. */
interface AcpModelOption {
  id: string;
  name: string;
  description?: string;
}

/**
 * Extracts available models from ACP session config options.
 *
 * Looks for config options with category "model" or id "model" that have
 * `type: "select"`. Options may be flat or grouped (SessionConfigSelectGroup).
 *
 * Returns `{ configId, models }` — the configId is needed to call
 * `session/set_config_option` later.
 */
function extractModelConfig(
  configOptions:
    | Array<{
        id?: string;
        name?: string;
        category?: string | null;
        type?: string;
        currentValue?: unknown;
        options?: unknown;
      }>
    | null
    | undefined,
): { configId: string; models: AcpModelOption[] } | null {
  if (!configOptions || configOptions.length === 0) return null;
  // Prefer category "model", fallback to id "model"
  const opt =
    configOptions.find((o) => o.category === "model" && o.type === "select") ??
    configOptions.find((o) => o.id === "model" && o.type === "select");
  if (!opt || !opt.id) return null;

  const rawOptions = opt.options;
  if (!Array.isArray(rawOptions)) return null;

  const models: AcpModelOption[] = [];
  for (const item of rawOptions) {
    if (!item || typeof item !== "object") continue;
    // Flat option: { value, name, description? }
    if (typeof (item as { value?: unknown }).value === "string") {
      const flat = item as { value: string; name?: string; description?: string | null };
      models.push({
        id: flat.value,
        name: flat.name || flat.value,
        ...(flat.description ? { description: flat.description } : {}),
      });
    }
    // Grouped option: { name, options: [{value, name, description?}...] }
    else if (Array.isArray((item as { options?: unknown }).options)) {
      const group = item as {
        name?: string;
        options: Array<{ value?: string; name?: string; description?: string | null }>;
      };
      for (const sub of group.options) {
        if (typeof sub.value === "string") {
          models.push({
            id: sub.value,
            name: sub.name || sub.value,
            ...(sub.description ? { description: sub.description } : {}),
          });
        }
      }
    }
  }

  return models.length > 0 ? { configId: opt.id, models } : null;
}

export type AcpAgentConfig = {
  command: string;
  args?: string[];
  env?: Record<string, string>;
};

export type RunAcpAgentInput = {
  agent: AcpAgentConfig;
  prompt: string;
  cwd: string;
  abortController: AbortController;
  checkpoint: CheckpointSession;
  /** ACP session id from a previous turn (carried via the sdkSessionId slot). */
  acpSessionId?: string;
  /** User-selected model id from the channel model list (informational). */
  model?: string;
  conversationHistory?: Array<{ role: "user" | "assistant"; content: string }>;
  attachments?: AttachmentPart[];
  mcpServers?: Record<string, Record<string, unknown>>;
  requestApproval: (input: {
    toolUseId: string;
    toolName: string;
    toolInput: Record<string, unknown>;
    decisionReason?: string;
  }) => Promise<boolean>;
  onEvent: (event: AgentEvent) => void;
  onSessionId: (sessionId: string) => void;
  onCheckpointReady?: (runId: string) => void;
};

// Mirrors codex.ts: a child that ignores SIGTERM must not linger — ACP agents
// run their own in-process shell tools, so an orphan keeps full user privileges.
const SIGKILL_ESCALATION_MS = 4000;
// After session/cancel the agent MUST answer the in-flight session/prompt with
// stopReason "cancelled". If it doesn't within this window, the process is torn
// down so a hung agent can't wedge the run forever.
const CANCEL_GRACE_MS = 5000;
// An agent process is kept alive between turns so the ACP session retains its
// context server-side. Idle entries past this TTL are reaped.
const IDLE_TTL_MS = 10 * 60 * 1000;
const STDERR_TAIL_LIMIT = 8 * 1024;

type TurnState = {
  onEvent: (event: AgentEvent) => void;
  requestApproval: RunAcpAgentInput["requestApproval"];
  checkpoint: CheckpointSession;
  /** Pending session/request_permission resolvers, so cancel can answer them all. */
  pendingPermissions: Set<(response: acp.RequestPermissionResponse) => void>;
  usage: {
    promptTokens: number;
    completionTokens: number;
    contextSize?: number;
    cost?: { amount: number; currency: string };
  };
};

type AcpEntry = {
  configKey: string;
  cwd: string;
  child: ChildProcess;
  connection: acp.ClientConnection;
  session: acp.ActiveSession;
  sessionId: string;
  stderrTail: string;
  lastUsedAt: number;
  turn: TurnState | null;
  dead: boolean;
  /** Agent identity from initialize response, emitted once per turn. */
  agentInfo?: { name: string; version: string };
  /** ACP model config option id (for set_config_option calls). */
  modelConfigId?: string;
  /** Dynamic model list from ACP session config options. */
  availableModels?: AcpModelOption[];
};

/** Live agent processes keyed by ACP session id (one process per conversation). */
const entries = new Map<string, AcpEntry>();

const reaper = setInterval(() => {
  const now = Date.now();
  for (const entry of entries.values()) {
    if (!entry.turn && now - entry.lastUsedAt > IDLE_TTL_MS) {
      destroyEntry(entry);
    }
  }
}, 60 * 1000);
reaper.unref?.();

// Last-resort orphan guard: if the sidecar itself dies, take the process
// groups down with it. Signal handlers are not touched — Bun already exits on
// SIGTERM, which fires this hook.
process.on("exit", () => {
  for (const entry of entries.values()) {
    killProcessTree(entry.child, "SIGKILL");
  }
});

function killProcessTree(child: ChildProcess, signal: NodeJS.Signals) {
  const pid = child.pid;
  try {
    // Negative pid targets the whole process group (the child is spawned
    // detached), so MCP servers or shells the agent forked die with it.
    if (pid && process.platform !== "win32") {
      process.kill(-pid, signal);
    } else {
      child.kill(signal);
    }
  } catch {
    // already dead
  }
}

function destroyEntry(entry: AcpEntry) {
  if (entry.dead) return;
  entry.dead = true;
  entries.delete(entry.sessionId);
  try {
    entry.connection.close();
  } catch {
    // stream already gone
  }
  killProcessTree(entry.child, "SIGTERM");
  const timer = setTimeout(() => killProcessTree(entry.child, "SIGKILL"), SIGKILL_ESCALATION_MS);
  timer.unref?.();
}

function buildAcpEnv(configEnv?: Record<string, string>): NodeJS.ProcessEnv {
  const env = sanitizeChildEnv({ ...process.env });
  // The sidecar may run with Tauri's minimal PATH; extend it with the common
  // install locations so a bare command name (e.g. "gemini") still resolves.
  env.PATH = `${env.PATH ?? ""}:/opt/homebrew/bin:/usr/local/bin:${homedir()}/.local/bin`;
  return { ...env, ...configEnv };
}

function configKeyOf(config: AcpAgentConfig, cwd: string): string {
  return JSON.stringify([config.command, config.args ?? [], config.env ?? {}, cwd]);
}

function contentBlockText(content: acp.ContentBlock): string {
  return content.type === "text" ? content.text : "";
}

/** Extract diff entries from ACP tool call content array. */
function extractToolCallDiff(
  content: Array<{ type: string; path?: string; oldText?: string | null; newText?: string }>,
): AgentToolDiff | undefined {
  for (const item of content) {
    if (item.type === "diff" && typeof item.path === "string" && typeof item.newText === "string") {
      return {
        path: item.path,
        oldText: item.oldText ?? null,
        newText: item.newText,
      };
    }
  }
  return undefined;
}

/** Extract text content from ACP tool call content array. */
function extractToolCallText(content: Array<{ type: string; content?: acp.ContentBlock }>): string {
  return content
    .map((item) => (item.type === "content" && item.content ? contentBlockText(item.content) : ""))
    .filter(Boolean)
    .join("\n");
}

/** Extract locations from ACP tool call. */
function extractLocations(
  locations?: Array<{ path: string; line?: number }>,
): AgentToolLocation[] | undefined {
  if (!locations || locations.length === 0) return undefined;
  return locations.map((loc) => ({
    path: loc.path,
    ...(loc.line != null ? { line: loc.line } : {}),
  }));
}

/** Exported for tests: maps one ACP session/update to an AgentEvent (or array). */
export function mapAcpUpdate(update: acp.SessionUpdate): AgentEvent | AgentEvent[] | null {
  switch (update.sessionUpdate) {
    case "agent_message_chunk": {
      const text = contentBlockText(update.content);
      return text ? { type: "text", content: text } : null;
    }
    case "agent_thought_chunk": {
      const text = contentBlockText(update.content);
      return text ? { type: "thinking", content: text } : null;
    }
    case "tool_call": {
      const rawInput =
        update.rawInput && typeof update.rawInput === "object"
          ? (update.rawInput as Record<string, unknown>)
          : undefined;
      const contentArr = (update.content ?? []) as Array<{
        type: string;
        path?: string;
        oldText?: string | null;
        newText?: string;
        content?: acp.ContentBlock;
      }>;
      const events: AgentEvent[] = [
        {
          type: "tool_call_detail",
          toolCallId: update.toolCallId,
          title: update.title || update.kind || "tool",
          kind: update.kind ?? undefined,
          status: update.status ?? "pending",
          locations: extractLocations(
            update.locations as Array<{ path: string; line?: number }> | undefined,
          ),
          rawInput,
          diff: extractToolCallDiff(contentArr),
          content: extractToolCallText(contentArr) || undefined,
        },
      ];
      // Also emit the legacy tool_start so non-ACP-aware renderers still work.
      events.push({
        type: "tool_start",
        toolName: update.title || update.kind || "tool",
        toolInput: rawInput,
      });
      return events;
    }
    case "tool_call_update": {
      const contentArr = (update.content ?? []) as Array<{
        type: string;
        path?: string;
        oldText?: string | null;
        newText?: string;
        content?: acp.ContentBlock;
      }>;
      const text = extractToolCallText(contentArr);
      const events: AgentEvent[] = [
        {
          type: "tool_call_detail",
          toolCallId: update.toolCallId,
          title: update.title || "",
          kind: update.kind ?? undefined,
          status: update.status ?? "in_progress",
          locations: extractLocations(
            update.locations as Array<{ path: string; line?: number }> | undefined,
          ),
          diff: extractToolCallDiff(contentArr),
          content: text || undefined,
        },
      ];
      // Emit legacy tool_result only when the tool call reaches a terminal status.
      if (update.status === "completed" || update.status === "failed") {
        events.push({ type: "tool_result", content: text || undefined });
      }
      return events;
    }
    case "plan":
      return {
        type: "plan",
        entries: ((update as unknown as { entries?: unknown[] }).entries ?? []).map((entry) => {
          const e = entry as { content?: string; priority?: string; status?: string };
          return {
            content: e.content ?? "",
            priority: e.priority ?? "medium",
            status: e.status ?? "pending",
          };
        }),
      };
    case "config_option_update": {
      // Extract model config from the updated options and emit available_models.
      const configUpdate = update as unknown as {
        configOptions?: Array<{
          id?: string;
          name?: string;
          category?: string | null;
          type?: string;
          currentValue?: unknown;
          options?: unknown;
        }>;
      };
      const mc = extractModelConfig(configUpdate.configOptions);
      if (mc) {
        return { type: "available_models", models: mc.models };
      }
      return null;
    }
    default:
      // Mode changes, slash-command lists, unknown extensions: the ACP surface
      // is wider than AgentEvent — unknown updates are dropped, not errors
      // (lenient-read rule from the client-implementations research).
      return null;
  }
}

/**
 * Exported for tests: token usage out of one session/update notification.
 *
 * Two shapes exist in the wild (no stable per-turn standard in ACP v1):
 *  - `usage_update { used, size }` (claude-agent-acp, per Session Usage RFD):
 *    `used` is session context occupancy — reported as promptTokens with no
 *    completion split, which matches what the figure actually is.
 *  - Gemini CLI's private `_meta.token_count { input_tokens, output_tokens }`
 *    carried on the notification.
 */
export function readAcpUsage(notification: acp.SessionNotification): {
  promptTokens: number;
  completionTokens: number;
  contextSize?: number;
  cost?: { amount: number; currency: string };
} | null {
  const meta = (notification._meta ?? {}) as Record<string, unknown>;
  const tokenCount = meta.token_count as Record<string, unknown> | undefined;
  if (tokenCount && typeof tokenCount === "object") {
    return {
      promptTokens: toCount(tokenCount.input_tokens),
      completionTokens: toCount(tokenCount.output_tokens),
    };
  }
  if (notification.update.sessionUpdate === "usage_update") {
    const update = notification.update as {
      used?: unknown;
      size?: unknown;
      cost?: { amount?: unknown; currency?: unknown };
    };
    const contextSize = toCount(update.size) || undefined;
    let cost: { amount: number; currency: string } | undefined;
    if (
      update.cost &&
      typeof update.cost === "object" &&
      typeof update.cost.amount === "number" &&
      typeof update.cost.currency === "string"
    ) {
      cost = { amount: update.cost.amount, currency: update.cost.currency };
    }
    return {
      promptTokens: toCount(update.used),
      completionTokens: 0,
      contextSize,
      cost,
    };
  }
  return null;
}

/**
 * Exported for tests: picks the option id to answer a permission request with.
 * Falls back to name matching for agents that omit `kind` (a known protocol
 * dialect — see the obsidian-agent-client compatibility layer).
 */
export function pickPermissionOption(
  options: Array<{ optionId: string; name?: string; kind?: string }>,
  allow: boolean,
): string | null {
  const kinds = allow ? ["allow_once", "allow_always"] : ["reject_once", "reject_always"];
  for (const kind of kinds) {
    const hit = options.find((option) => option.kind === kind);
    if (hit) return hit.optionId;
  }
  const needles = allow ? ["allow"] : ["reject", "deny"];
  for (const needle of needles) {
    const byName = options.find((option) => option.name?.toLowerCase().includes(needle));
    if (byName) return byName.optionId;
  }
  return null;
}

async function handlePermissionRequest(
  entry: AcpEntry,
  params: acp.RequestPermissionRequest,
): Promise<acp.RequestPermissionResponse> {
  const turn = entry.turn;
  if (!turn) {
    return { outcome: { outcome: "cancelled" } };
  }
  const toolCall = params.toolCall;
  const rawInput =
    toolCall.rawInput && typeof toolCall.rawInput === "object"
      ? (toolCall.rawInput as Record<string, unknown>)
      : {};

  // Same policy as the Claude runtime's canUseTool: only shell execution is
  // risk-gated; everything else is auto-allowed because file access is already
  // workspace-bounded by the client fs handlers.
  let decisionReason: string | undefined;
  if (toolCall.kind === "execute") {
    const command = typeof rawInput.command === "string" ? rawInput.command : "";
    const risk = classifyBashCommandRisk(command);
    if (risk.level !== "allow") {
      decisionReason = risk.reason;
      const respond = (allow: boolean): acp.RequestPermissionResponse => {
        const optionId = pickPermissionOption(params.options, allow);
        return optionId
          ? { outcome: { outcome: "selected", optionId } }
          : { outcome: { outcome: "cancelled" } };
      };
      return new Promise<acp.RequestPermissionResponse>((resolve) => {
        turn.pendingPermissions.add(resolve);
        turn
          .requestApproval({
            toolUseId: toolCall.toolCallId || crypto.randomUUID(),
            toolName: toolCall.title || "execute",
            toolInput: rawInput,
            decisionReason,
          })
          .then((allow) => {
            // Already answered "cancelled" by an abort — the protocol forbids a
            // second response.
            if (!turn.pendingPermissions.has(resolve)) return;
            turn.pendingPermissions.delete(resolve);
            resolve(respond(allow));
          })
          .catch(() => {
            if (!turn.pendingPermissions.has(resolve)) return;
            turn.pendingPermissions.delete(resolve);
            resolve({ outcome: { outcome: "cancelled" } });
          });
      });
    }
  }

  const optionId = pickPermissionOption(params.options, true);
  return optionId
    ? { outcome: { outcome: "selected", optionId } }
    : { outcome: { outcome: "cancelled" } };
}

async function handleReadTextFile(
  entry: AcpEntry,
  params: acp.ReadTextFileRequest,
): Promise<acp.ReadTextFileResponse> {
  const { fsReadText } = await import("../fs");
  const relative = toWorkspaceRelative(entry.cwd, params.path);
  // Out-of-workspace reads (e.g. the agent's own ~/.claude session files) are
  // refused; the agent falls back to its in-process Read tool. fs escapes must
  // not fail the turn (Zed #60156 lesson).
  const { content } = await fsReadText({ workspaceRoot: entry.cwd, filePath: relative });
  if (params.line == null && params.limit == null) return { content };
  const lines = content.split("\n");
  const start = Math.max((params.line ?? 1) - 1, 0);
  const end = params.limit != null ? start + params.limit : lines.length;
  return { content: lines.slice(start, end).join("\n") };
}

async function handleWriteTextFile(entry: AcpEntry, params: acp.WriteTextFileRequest) {
  const { fsWriteText } = await import("../fs");
  const relative = toWorkspaceRelative(entry.cwd, params.path);
  const turn = entry.turn;
  if (turn) {
    try {
      await ensureCheckpointBackup(turn.checkpoint, relative);
    } catch (error) {
      // Best-effort, same as the Claude runtime's PreToolUse hook: a checkpoint
      // failure must not block the write, but it must be visible.
      console.error(
        `[acp-agent] checkpoint backup failed for ${params.path}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }
  await fsWriteText({ workspaceRoot: entry.cwd, filePath: relative, content: params.content });
}

function toAcpMcpServers(mcpServers?: Record<string, Record<string, unknown>>): acp.McpServer[] {
  if (!mcpServers) return [];
  const servers: acp.McpServer[] = [];
  for (const [name, config] of Object.entries(mcpServers)) {
    const command = typeof config.command === "string" ? config.command : null;
    const type = typeof config.type === "string" ? config.type : "stdio";
    // Only stdio servers are passed through: http/sse support is an agent
    // capability we don't probe in the MVP.
    if (!command || type !== "stdio") continue;
    const env = (config.env ?? {}) as Record<string, unknown>;
    servers.push({
      name,
      command,
      args: Array.isArray(config.args) ? config.args.filter((a) => typeof a === "string") : [],
      env: Object.entries(env)
        .filter(([, value]) => typeof value === "string")
        .map(([envName, value]) => ({ name: envName, value: value as string })),
    });
  }
  return servers;
}

function appendStderr(entry: AcpEntry, chunk: string) {
  entry.stderrTail = (entry.stderrTail + chunk).slice(-STDERR_TAIL_LIMIT);
}

/** Last contiguous stderr block, for error context (Zed's trailing_stderr). */
function stderrHint(entry: AcpEntry): string {
  const tail = entry.stderrTail.trim().split("\n").slice(-6).join("\n");
  return tail ? `\n${tail}` : "";
}

/** Minimum input to spawn an ACP agent and establish a session. */
type CreateEntryInput = {
  agent: AcpAgentConfig;
  cwd: string;
  mcpServers?: Record<string, Record<string, unknown>>;
};

async function createEntry(input: CreateEntryInput): Promise<AcpEntry> {
  const { agent: config, cwd } = input;
  const child = spawn(config.command, config.args ?? [], {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: buildAcpEnv(config.env),
    detached: process.platform !== "win32",
  });

  // Filled in below; handlers capture the holder so they can reach the entry
  // that owns their connection.
  const holder: { entry: AcpEntry | null } = { entry: null };
  let stderrBuffer = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    if (holder.entry) {
      appendStderr(holder.entry, text);
    } else {
      stderrBuffer = (stderrBuffer + text).slice(-STDERR_TAIL_LIMIT);
    }
  });

  // Zed pattern: race the handshake against child exit so a binary that can't
  // start fails fast with its stderr instead of hanging until a timeout.
  let exitedEarly: (reason: Error) => void = () => {};
  const earlyExit = new Promise<never>((_, reject) => {
    exitedEarly = reject;
  });
  const onSpawnFailure = (detail: string) => {
    exitedEarly(
      new Error(
        `ACP agent 启动失败（${config.command}）: ${detail}${stderrBuffer ? `\n${stderrBuffer.trim().split("\n").slice(-6).join("\n")}` : ""}`,
      ),
    );
  };
  child.once("error", (err) => onSpawnFailure(err.message));
  child.once("close", (code) => onSpawnFailure(`进程退出，代码 ${code ?? "unknown"}`));

  if (!child.stdin || !child.stdout) {
    killProcessTree(child, "SIGKILL");
    throw new Error("ACP agent process was spawned without stdio pipes");
  }
  const stream = acp.ndJsonStream(
    Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
    Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
  );

  const connection = acp
    .client({ name: "openhorn" })
    .onRequest(acp.CLIENT_METHODS.session_request_permission, (ctx) => {
      const entry = holder.entry;
      if (!entry) return { outcome: { outcome: "cancelled" as const } };
      return handlePermissionRequest(entry, ctx.params);
    })
    .onRequest(acp.CLIENT_METHODS.fs_read_text_file, (ctx) => {
      const entry = holder.entry;
      if (!entry) throw new Error("Resource not found");
      return handleReadTextFile(entry, ctx.params);
    })
    .onRequest(acp.CLIENT_METHODS.fs_write_text_file, (ctx) => {
      const entry = holder.entry;
      if (!entry) throw new Error("Resource not found");
      return handleWriteTextFile(entry, ctx.params);
    })
    .connect(stream);

  try {
    const init = await Promise.race([
      connection.agent.request(acp.AGENT_METHODS.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
        clientInfo: { name: "openhorn", title: "OpenHorn", version: "1.0.0" },
      }),
      earlyExit,
    ]);
    if (init.protocolVersion !== acp.PROTOCOL_VERSION) {
      throw new Error(`ACP 协议版本不匹配：agent 返回 v${init.protocolVersion}，需要 v1`);
    }

    const builder = connection.agent.buildSession(cwd);
    for (const server of toAcpMcpServers(input.mcpServers)) {
      builder.withMcpServer(server);
    }
    const session = await Promise.race([builder.start(), earlyExit]);

    // Capture agentInfo from the initialize response for the UI.
    const agentInfo =
      init.agentInfo &&
      typeof init.agentInfo === "object" &&
      typeof (init.agentInfo as { name?: unknown }).name === "string"
        ? {
            name: (init.agentInfo as { name: string }).name,
            version:
              typeof (init.agentInfo as { version?: unknown }).version === "string"
                ? (init.agentInfo as { version: string }).version
                : "",
          }
        : undefined;

    // Extract model config options from session/new response.
    const sessionResponse = session.newSessionResponse;
    const modelConfig = extractModelConfig(
      sessionResponse.configOptions as
        | Array<{
            id?: string;
            name?: string;
            category?: string | null;
            type?: string;
            currentValue?: unknown;
            options?: unknown;
          }>
        | null
        | undefined,
    );

    const entry: AcpEntry = {
      configKey: configKeyOf(config, cwd),
      cwd,
      child,
      connection,
      session,
      sessionId: session.sessionId,
      stderrTail: stderrBuffer,
      lastUsedAt: Date.now(),
      turn: null,
      dead: false,
      agentInfo,
      modelConfigId: modelConfig?.configId,
      availableModels: modelConfig?.models,
    };
    holder.entry = entry;
    // Handshake survived — from here on, an exit means the running entry died.
    child.removeAllListeners("close");
    child.once("close", () => {
      if (!entry.dead) destroyEntry(entry);
    });
    return entry;
  } catch (error) {
    try {
      connection.close();
    } catch {
      // stream already gone
    }
    killProcessTree(child, "SIGKILL");
    throw error;
  }
}

/**
 * Pre-connects to an ACP agent: spawns the process, completes initialize +
 * session/new, and returns the session id, dynamic model list, and agent
 * identity. If a live idle entry with the same config already exists, reuses
 * it instead of spawning a second process.
 *
 * The entry stays alive in the entries Map (10 min idle TTL). The subsequent
 * `runAcpAgent` call reuses it via the returned `sessionId`.
 */
export async function preconnectAcpAgent(input: CreateEntryInput): Promise<{
  sessionId: string;
  models: Array<{ id: string; name: string; description?: string }>;
  agentInfo?: { name: string; version: string };
}> {
  const configKey = configKeyOf(input.agent, input.cwd);

  // Reuse existing idle entry with matching config.
  for (const entry of entries.values()) {
    if (!entry.dead && entry.configKey === configKey && !entry.turn) {
      entry.lastUsedAt = Date.now();
      return {
        sessionId: entry.sessionId,
        models: entry.availableModels ?? [],
        agentInfo: entry.agentInfo,
      };
    }
  }

  const entry = await createEntry(input);
  entries.set(entry.sessionId, entry);
  return {
    sessionId: entry.sessionId,
    models: entry.availableModels ?? [],
    agentInfo: entry.agentInfo,
  };
}

export async function runAcpAgent(input: RunAcpAgentInput): Promise<void> {
  const { abortController, onEvent } = input;
  if (abortController.signal.aborted) {
    onEvent({ type: "done" });
    return;
  }

  // Reuse the conversation's live agent process when the desktop passed the
  // session id back (the same slot the Claude runtime uses for SDK resume).
  const configKey = configKeyOf(input.agent, input.cwd);
  let entry: AcpEntry | null = null;
  if (input.acpSessionId) {
    const existing = entries.get(input.acpSessionId);
    if (existing && !existing.dead && existing.configKey === configKey && !existing.turn) {
      entry = existing;
    }
  }

  let isNewSession = false;
  if (!entry) {
    try {
      entry = await createEntry(input);
    } catch (error) {
      onEvent({
        type: "error",
        content: error instanceof Error ? error.message : "ACP agent 启动失败",
      });
      onEvent({ type: "done" });
      return;
    }
    isNewSession = true;
    entries.set(entry.sessionId, entry);
    input.onSessionId(entry.sessionId);
  }

  // History is only replayed into the prompt when the ACP session itself is
  // fresh (process died or first turn) — a live session already has context.
  let promptText = input.prompt;
  if (isNewSession && input.conversationHistory && input.conversationHistory.length > 0) {
    const historyBlock = input.conversationHistory
      .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
      .join("\n\n");
    promptText = `${historyBlock}\n\n---\n\nUser: ${input.prompt}`;
  }
  promptText = appendAttachmentContext(promptText, input.attachments);

  const turn: TurnState = {
    onEvent,
    requestApproval: input.requestApproval,
    checkpoint: input.checkpoint,
    pendingPermissions: new Set(),
    usage: { promptTokens: 0, completionTokens: 0 },
  };
  entry.turn = turn;
  entry.lastUsedAt = Date.now();

  let cancelTimer: ReturnType<typeof setTimeout> | null = null;
  const activeEntry = entry;
  const handleAbort = () => {
    // Protocol MUST: answer every pending permission request with "cancelled"
    // before/while cancelling, or the agent's await hangs forever.
    for (const resolve of turn.pendingPermissions) {
      resolve({ outcome: { outcome: "cancelled" } });
    }
    turn.pendingPermissions.clear();
    void activeEntry.connection.agent
      .notify(acp.AGENT_METHODS.session_cancel, { sessionId: activeEntry.sessionId })
      .catch(() => {});
    // A well-behaved agent responds with stopReason "cancelled"; one that
    // doesn't gets its process torn down.
    cancelTimer = setTimeout(() => destroyEntry(activeEntry), CANCEL_GRACE_MS);
    cancelTimer.unref?.();
  };
  abortController.signal.addEventListener("abort", handleAbort, { once: true });

  // Emit agent_info at the start of the turn so the UI can display it.
  if (entry.agentInfo) {
    onEvent({
      type: "agent_info",
      agentName: entry.agentInfo.name,
      agentVersion: entry.agentInfo.version,
    });
  }

  // Emit available models from session config options.
  if (entry.availableModels && entry.availableModels.length > 0) {
    onEvent({ type: "available_models", models: entry.availableModels });
  }

  // If the user selected a specific model (from the ACP model picker), apply it
  // via session/set_config_option before the prompt. Only call when the model
  // matches a known option to avoid spurious errors on placeholder values.
  if (input.model && entry.modelConfigId && entry.availableModels) {
    const isKnownModel = entry.availableModels.some((m) => m.id === input.model);
    if (isKnownModel) {
      try {
        const resp = await entry.connection.agent.request(
          acp.AGENT_METHODS.session_set_config_option,
          {
            sessionId: entry.sessionId,
            configId: entry.modelConfigId,
            value: input.model,
          },
        );
        // Update the entry's available models from the response.
        const updatedConfig = extractModelConfig(
          (resp as { configOptions?: unknown }).configOptions as
            | Array<{
                id?: string;
                name?: string;
                category?: string | null;
                type?: string;
                currentValue?: unknown;
                options?: unknown;
              }>
            | null
            | undefined,
        );
        if (updatedConfig) {
          entry.modelConfigId = updatedConfig.configId;
          entry.availableModels = updatedConfig.models;
        }
      } catch (error) {
        // Best-effort: a failed set_config_option must not block the prompt.
        console.error(
          "[acp-agent] set_config_option failed:",
          error instanceof Error ? error.message : error,
        );
      }
    }
  }

  try {
    const promptDone = entry.session.prompt(promptText);
    // The stop message below is the real completion signal; this catch only
    // prevents an unhandled rejection when the connection dies mid-turn.
    promptDone.catch(() => {});

    // `closed` REJECTS when the connection is torn down with an error — which
    // is exactly what destroyEntry's close() produces when the cancel grace
    // timer kills a hung agent. Both outcomes mean the same thing here.
    const connectionClosed = entry.connection.closed.then(
      () => ({ kind: "closed" as const }),
      () => ({ kind: "closed" as const }),
    );
    let updateCount = 0;
    for (;;) {
      // nextUpdate() can also reject when the connection dies between races;
      // fold that into the "closed" outcome instead of throwing out of the run.
      const message = await Promise.race([
        entry.session.nextUpdate().catch(() => ({ kind: "closed" as const })),
        connectionClosed,
      ]);
      if (message.kind === "closed") {
        if (!abortController.signal.aborted) {
          onEvent({ type: "error", content: `ACP agent 进程意外退出${stderrHint(entry)}` });
        }
        destroyEntry(entry);
        break;
      }
      if (message.kind === "stop") {
        if (message.stopReason === "refusal") {
          onEvent({ type: "error", content: "Agent 拒绝了本次请求" });
        } else if (message.stopReason === "end_turn" && updateCount === 0) {
          // "end_turn with zero updates" is the silent-failure signature: the
          // agent hit a config error (missing API key, not logged in …) and
          // only said so on stderr.
          onEvent({
            type: "error",
            content: `Agent 结束了回合但没有产生任何输出，请检查其认证配置${stderrHint(entry)}`,
          });
        }
        break;
      }
      updateCount++;
      const usage = readAcpUsage(message.notification);
      if (usage) {
        // Assigned, not accumulated: both known shapes report totals that
        // supersede the previous notification.
        turn.usage = usage;
        // Emit a context_usage event to the UI so it can show the live bar.
        onEvent({
          type: "usage",
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
          totalTokens: usage.promptTokens + usage.completionTokens,
          contextSize: usage.contextSize,
          cost: usage.cost,
        });
        continue;
      }
      const mapped = mapAcpUpdate(message.update);
      if (mapped) {
        // mapAcpUpdate may return a single event or an array (e.g. tool_call
        // emits both tool_call_detail and legacy tool_start).
        const events = Array.isArray(mapped) ? mapped : [mapped];
        for (const event of events) {
          // When a config_option_update arrives with model changes, update the
          // entry so future turns see the refreshed list.
          if (event.type === "available_models") {
            entry.availableModels = event.models;
          }
          onEvent(event);
        }
      }
    }

    const usage = buildUsageEvent(turn.usage.promptTokens, turn.usage.completionTokens);
    if (usage) {
      // Carry contextSize and cost onto the final usage event.
      if (turn.usage.contextSize || turn.usage.cost) {
        (
          usage as { contextSize?: number; cost?: { amount: number; currency: string } }
        ).contextSize = turn.usage.contextSize;
        (usage as { cost?: { amount: number; currency: string } }).cost = turn.usage.cost;
      }
      onEvent(usage);
    }
  } finally {
    abortController.signal.removeEventListener("abort", handleAbort);
    if (cancelTimer) clearTimeout(cancelTimer);
    entry.turn = null;
    entry.lastUsedAt = Date.now();
    if (input.checkpoint.files.size > 0) {
      try {
        await finalizeCheckpoint(input.checkpoint);
        input.onCheckpointReady?.(input.checkpoint.runId);
      } catch {
        // Best-effort, same as the Claude runtime.
      }
    }
  }

  onEvent({ type: "done" });
}
