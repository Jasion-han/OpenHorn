/**
 * Desktop ↔ sidecar client.
 *
 * The sidecar exposes a WebSocket JSON-RPC (see apps/sidecar/src/protocol.ts)
 * and a parallel stream of server events. This module wraps that wire
 * format in a small typed client so the rest of the desktop code can
 * treat sidecar runs the same way it treats server-backed runs.
 *
 * Design decisions:
 *
 *  - The WebSocket constructor is injected so tests can substitute a
 *    mock without monkey-patching globals.
 *  - Requests are promises keyed by requestId. Events fan out through
 *    subscription handlers. We never mix the two queues.
 *  - Sidecar AgentEvents are projected into the `AgentTaskStreamEvent`
 *    shape the existing task-card renderer already understands. The
 *    sidecar runtime has no notion of "task" / "plan step" / "final
 *    result" — we use the sidecar runId for both taskId and runId in
 *    the projected events so the UI can key off a single identifier.
 *  - Approvals coming from the sidecar are surfaced through a separate
 *    onApproval callback because they need an out-of-band response
 *    (the sidecar is blocking the run waiting for `approvals.respond`).
 */

import type { AgentTaskStreamEvent } from "./agentTaskStream";

/**
 * Minimal WebSocket surface we depend on. The browser built-in satisfies
 * it; tests inject a mock that conforms to the same shape.
 */
export interface SidecarWebSocketLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(
    type: "open" | "message" | "close" | "error",
    listener: (event: unknown) => void,
  ): void;
  removeEventListener(
    type: "open" | "message" | "close" | "error",
    listener: (event: unknown) => void,
  ): void;
}

export type SidecarWebSocketFactory = (url: string) => SidecarWebSocketLike;

export interface SidecarEndpoint {
  host: string;
  port: number;
  token: string;
}

export interface SidecarApprovalRequest {
  runId: string;
  toolUseId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  decisionReason?: string;
  blockedPath?: string;
}

export interface SidecarRunAgentInput {
  prompt: string;
  apiKey: string;
  model: string;
  baseUrl?: string;
  protocol?: string;
  sdkSessionId?: string;
  permissionMode?: "default" | "full-access";
  conversationHistory?: Array<{ role: "user" | "assistant"; content: string }>;
  onEvent: (event: AgentTaskStreamEvent) => void | Promise<void>;
  onApproval: (request: SidecarApprovalRequest) => void | Promise<void>;
  onError: (message: string) => void;
  onDone: (runId: string) => void;
  onSdkSessionId?: (sessionId: string) => void;
}

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
}

interface SidecarOutgoingRequest {
  type: "request";
  requestId: string;
  method: string;
  params?: unknown;
}

interface SidecarIncomingResponse {
  type: "response";
  requestId: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

interface SidecarIncomingEvent {
  type: "event";
  event: string;
  data?: unknown;
}

type SidecarIncoming = SidecarIncomingResponse | SidecarIncomingEvent;

/** Sidecar AgentEvent — see apps/sidecar/src/agent/events.ts. */
interface SidecarAgentEvent {
  type: "text" | "final_text" | "tool_start" | "tool_result" | "user_message" | "done" | "error";
  content?: string;
  toolName?: string;
  toolInput?: unknown;
  userMessageId?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function generateRequestId(): string {
  // crypto.randomUUID is available in modern Tauri webviews and in
  // Node/Bun test runtimes.
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `req-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Projects a sidecar AgentEvent (see apps/sidecar/src/agent/events.ts)
 * into the desktop's AgentTaskStreamEvent shape. The sidecar runtime
 * does not have plan steps / task status / artifacts, so this mapping
 * is strictly "raw agent output → execution_event" plus done/error.
 *
 * Exported for unit testing.
 */
export function projectSidecarAgentEvent(runId: string, raw: unknown): AgentTaskStreamEvent | null {
  if (!isRecord(raw)) return null;
  const event = raw as unknown as SidecarAgentEvent;

  switch (event.type) {
    case "text":
      return {
        type: "execution_event",
        taskId: runId,
        runId,
        eventType: "text",
        content: typeof event.content === "string" ? event.content : "",
      };
    case "final_text":
      return {
        type: "execution_event",
        taskId: runId,
        runId,
        eventType: "final_text",
        content: typeof event.content === "string" ? event.content : "",
      };
    case "tool_start":
      return {
        type: "execution_event",
        taskId: runId,
        runId,
        eventType: "tool_start",
        toolName: typeof event.toolName === "string" ? event.toolName : undefined,
        toolInput: event.toolInput,
      };
    case "tool_result":
      return {
        type: "execution_event",
        taskId: runId,
        runId,
        eventType: "tool_result",
        content: typeof event.content === "string" ? event.content : "",
      };
    case "done":
      return { type: "done", taskId: runId, runId };
    case "error":
      return {
        type: "error",
        taskId: runId,
        runId,
        content: typeof event.content === "string" ? event.content : "Agent error",
      };
    case "user_message":
      // The desktop renderer has no use for this; swallow it.
      return null;
    default:
      return null;
  }
}

export interface SidecarClientOptions {
  endpoint: SidecarEndpoint;
  createSocket?: SidecarWebSocketFactory;
}

export class SidecarClient {
  private socket: SidecarWebSocketLike | null = null;
  private pending = new Map<string, PendingRequest>();
  private runHandlers = new Map<
    string,
    {
      onEvent: (event: AgentTaskStreamEvent) => void | Promise<void>;
      onApproval: (request: SidecarApprovalRequest) => void | Promise<void>;
      onError: (message: string) => void;
      onDone: (runId: string) => void;
      onSdkSessionId?: (sessionId: string) => void;
    }
  >();
  private closePromise: Promise<void> | null = null;
  private closeResolve: (() => void) | null = null;
  private readonly endpoint: SidecarEndpoint;
  private readonly createSocket: SidecarWebSocketFactory;
  onDisconnect: (() => void) | null = null;

  constructor(options: SidecarClientOptions) {
    this.endpoint = options.endpoint;
    this.createSocket =
      options.createSocket ??
      ((url: string) => new WebSocket(url) as unknown as SidecarWebSocketLike);
  }

  /**
   * Opens the socket, performs the auth.handshake RPC, and resolves
   * when the sidecar confirms the connection. Rejects on auth failure
   * or socket-level error.
   */
  async connect(): Promise<void> {
    const url = `ws://${this.endpoint.host}:${this.endpoint.port}/`;
    const socket = this.createSocket(url);
    this.socket = socket;
    this.closePromise = new Promise<void>((resolve) => {
      this.closeResolve = resolve;
    });

    await new Promise<void>((resolve, reject) => {
      const onOpen = () => {
        socket.removeEventListener("open", onOpen);
        socket.removeEventListener("error", onError);
        resolve();
      };
      const onError = (err: unknown) => {
        socket.removeEventListener("open", onOpen);
        socket.removeEventListener("error", onError);
        reject(new Error(`sidecar socket error: ${describeError(err)}`));
      };
      socket.addEventListener("open", onOpen);
      socket.addEventListener("error", onError);
    });

    socket.addEventListener("message", (event) => {
      const data = extractMessageData(event);
      if (typeof data !== "string") return;
      this.onIncomingMessage(data);
    });
    socket.addEventListener("close", () => {
      this.handleSocketClose();
    });
    socket.addEventListener("error", (err) => {
      // Forward late socket errors to all in-flight runs.
      const message = `sidecar socket error: ${describeError(err)}`;
      for (const handlers of this.runHandlers.values()) {
        handlers.onError(message);
      }
    });

    await this.request("auth.handshake", { token: this.endpoint.token });
  }

  /** Sets the workspace root on the sidecar. */
  async setWorkspace(root: string): Promise<{ workspaceRoot: string }> {
    const result = (await this.request("workspace.setCurrent", { root })) as {
      workspaceRoot: string;
    };
    return result;
  }

  /**
   * Starts a Claude agent run inside the sidecar. Returns the runId
   * once the sidecar accepts the request. The event / approval / done
   * callbacks fire asynchronously until the run terminates.
   */
  async runAgent(input: SidecarRunAgentInput): Promise<string> {
    const {
      prompt,
      apiKey,
      model,
      baseUrl,
      protocol,
      sdkSessionId,
      permissionMode,
      conversationHistory,
      onEvent,
      onApproval,
      onError,
      onDone,
      onSdkSessionId,
    } = input;
    const result = (await this.request("agent.run", {
      prompt,
      apiKey,
      model,
      ...(baseUrl ? { baseUrl } : {}),
      ...(protocol ? { protocol } : {}),
      ...(sdkSessionId ? { sdkSessionId } : {}),
      ...(permissionMode ? { permissionMode } : {}),
      ...(conversationHistory && conversationHistory.length > 0 ? { conversationHistory } : {}),
    })) as { runId: string };
    const runId = result.runId;
    this.runHandlers.set(runId, { onEvent, onApproval, onError, onDone, onSdkSessionId });
    return runId;
  }

  async cancelRun(runId: string): Promise<void> {
    await this.request("agent.cancel", { runId });
  }

  async respondApproval(toolUseId: string, allow: boolean): Promise<void> {
    await this.request("approvals.respond", { toolUseId, allow });
  }

  async rollbackCheckpoint(runId: string): Promise<{ ok: true }> {
    const result = (await this.request("checkpoint.rollback", { runId })) as { ok: true };
    return result;
  }

  close(): Promise<void> {
    if (this.socket) {
      try {
        this.socket.close(1000, "client disposing");
      } catch {
        // ignore
      }
    }
    return this.closePromise ?? Promise.resolve();
  }

  private request(method: string, params?: unknown): Promise<unknown> {
    if (!this.socket) {
      return Promise.reject(new Error("sidecar socket not open"));
    }
    const requestId = generateRequestId();
    const payload: SidecarOutgoingRequest = {
      type: "request",
      requestId,
      method,
      ...(params !== undefined ? { params } : {}),
    };

    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      try {
        this.socket?.send(JSON.stringify(payload));
      } catch (error) {
        this.pending.delete(requestId);
        reject(new Error(`failed to send request: ${describeError(error)}`));
      }
    });
  }

  private onIncomingMessage(raw: string) {
    let parsed: SidecarIncoming;
    try {
      parsed = JSON.parse(raw) as SidecarIncoming;
    } catch {
      return;
    }

    if (parsed.type === "response") {
      const pending = this.pending.get(parsed.requestId);
      if (!pending) return;
      this.pending.delete(parsed.requestId);
      if (parsed.ok) {
        pending.resolve(parsed.result);
      } else {
        pending.reject(new Error(parsed.error || "sidecar request failed"));
      }
      return;
    }

    if (parsed.type === "event") {
      this.onServerEvent(parsed);
    }
  }

  private onServerEvent(event: SidecarIncomingEvent) {
    if (event.event === "agent.event") {
      if (!isRecord(event.data)) return;
      const runId = typeof event.data.runId === "string" ? event.data.runId : null;
      if (!runId) return;
      const handlers = this.runHandlers.get(runId);
      if (!handlers) return;

      const projected = projectSidecarAgentEvent(runId, event.data.event);
      if (projected === null) return;

      if (projected.type === "done") {
        handlers.onDone(runId);
        void handlers.onEvent(projected);
        this.runHandlers.delete(runId);
        return;
      }
      if (projected.type === "error") {
        handlers.onError(projected.content);
        // Still surface the error into the event stream so the UI can
        // show it alongside whatever process rows have already landed.
        void handlers.onEvent(projected);
        return;
      }
      void handlers.onEvent(projected);
      return;
    }

    if (event.event === "approval.request") {
      if (!isRecord(event.data)) return;
      const runId = typeof event.data.runId === "string" ? event.data.runId : null;
      if (!runId) return;
      const handlers = this.runHandlers.get(runId);
      if (!handlers) return;
      const request: SidecarApprovalRequest = {
        runId,
        toolUseId: typeof event.data.toolUseId === "string" ? event.data.toolUseId : "",
        toolName: typeof event.data.toolName === "string" ? event.data.toolName : "",
        toolInput: isRecord(event.data.toolInput)
          ? (event.data.toolInput as Record<string, unknown>)
          : {},
        decisionReason:
          typeof event.data.decisionReason === "string" ? event.data.decisionReason : undefined,
        blockedPath:
          typeof event.data.blockedPath === "string" ? event.data.blockedPath : undefined,
      };
      void handlers.onApproval(request);
      return;
    }

    if (event.event === "agent.session") {
      if (!isRecord(event.data)) return;
      const runId = typeof event.data.runId === "string" ? event.data.runId : null;
      if (!runId) return;
      const handlers = this.runHandlers.get(runId);
      if (!handlers?.onSdkSessionId) return;
      const sessionId =
        typeof event.data.sdkSessionId === "string" ? event.data.sdkSessionId : null;
      if (sessionId) handlers.onSdkSessionId(sessionId);
      return;
    }

    if (event.event === "checkpoint.ready") {
      return;
    }

    if (event.event === "protocol.error") {
      const message =
        isRecord(event.data) && typeof event.data.error === "string"
          ? event.data.error
          : "sidecar protocol error";
      for (const handlers of this.runHandlers.values()) {
        handlers.onError(message);
      }
    }
  }

  private handleSocketClose() {
    this.socket = null;
    for (const handlers of this.runHandlers.values()) {
      handlers.onError("sidecar connection closed");
    }
    this.runHandlers.clear();
    for (const pending of this.pending.values()) {
      pending.reject(new Error("sidecar connection closed"));
    }
    this.pending.clear();
    if (this.closeResolve) {
      this.closeResolve();
      this.closeResolve = null;
    }
    this.onDisconnect?.();
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (isRecord(error) && typeof error.message === "string") return error.message;
  return "unknown error";
}

function extractMessageData(event: unknown): unknown {
  if (isRecord(event) && "data" in event) {
    return (event as { data?: unknown }).data;
  }
  return event;
}
