import { describe, expect, test } from "bun:test";
import type { AgentTaskStreamEvent } from "./agentTaskStream";
import {
  projectSidecarAgentEvent,
  SidecarClient,
  type SidecarApprovalRequest,
  type SidecarWebSocketLike,
} from "./sidecarClient";

type Listener = (event: unknown) => void;

/**
 * In-memory WebSocket stand-in. The server side of the fake socket
 * calls `receive(...)` to deliver a message to the client, and reads
 * `sent` to observe what the client sent.
 */
class MockSocket implements SidecarWebSocketLike {
  readyState = 0;
  sent: string[] = [];
  private listeners: Record<string, Listener[]> = {
    open: [],
    message: [],
    close: [],
    error: [],
  };

  connect() {
    this.readyState = 1;
    for (const l of this.listeners.open) l({});
  }

  receive(raw: string) {
    for (const l of this.listeners.message) l({ data: raw });
  }

  errorOut(message: string) {
    for (const l of this.listeners.error) l(new Error(message));
  }

  forceClose() {
    this.readyState = 3;
    for (const l of this.listeners.close) l({});
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.readyState = 3;
    for (const l of this.listeners.close) l({});
  }

  addEventListener(type: keyof typeof this.listeners, listener: Listener) {
    this.listeners[type].push(listener);
  }

  removeEventListener(type: keyof typeof this.listeners, listener: Listener) {
    this.listeners[type] = this.listeners[type].filter((l) => l !== listener);
  }
}

function lastSent(socket: MockSocket): Record<string, unknown> {
  const raw = socket.sent[socket.sent.length - 1];
  if (!raw) throw new Error("no sent frames");
  return JSON.parse(raw) as Record<string, unknown>;
}

async function connectClient() {
  const socket = new MockSocket();
  const client = new SidecarClient({
    endpoint: { host: "127.0.0.1", port: 54321, token: "test-token" },
    createSocket: () => socket,
  });

  const connectPromise = client.connect();

  // Flush microtasks so the client registers its open listener, then
  // simulate the socket connecting and the handshake response.
  await Promise.resolve();
  socket.connect();

  // Wait a tick so the request is sent before we inject the response.
  await Promise.resolve();
  const handshakeRequest = lastSent(socket);
  socket.receive(
    JSON.stringify({
      type: "response",
      requestId: handshakeRequest.requestId,
      ok: true,
      result: { ok: true },
    }),
  );

  await connectPromise;
  return { client, socket };
}

describe("projectSidecarAgentEvent", () => {
  test("projects text events as execution_event:text", () => {
    const result = projectSidecarAgentEvent("run-1", { type: "text", content: "hello" });
    expect(result).toEqual({
      type: "execution_event",
      taskId: "run-1",
      runId: "run-1",
      eventType: "text",
      content: "hello",
    });
  });

  test("projects tool_start with toolName and toolInput", () => {
    const result = projectSidecarAgentEvent("run-2", {
      type: "tool_start",
      toolName: "Bash",
      toolInput: { command: "pwd" },
    });
    expect(result).toEqual({
      type: "execution_event",
      taskId: "run-2",
      runId: "run-2",
      eventType: "tool_start",
      toolName: "Bash",
      toolInput: { command: "pwd" },
    });
  });

  test("projects tool_result content", () => {
    const result = projectSidecarAgentEvent("run-3", {
      type: "tool_result",
      content: "/home/u",
    });
    expect(result).toEqual({
      type: "execution_event",
      taskId: "run-3",
      runId: "run-3",
      eventType: "tool_result",
      content: "/home/u",
    });
  });

  test("projects done", () => {
    const result = projectSidecarAgentEvent("run-4", { type: "done" });
    expect(result).toEqual({ type: "done", taskId: "run-4", runId: "run-4" });
  });

  test("projects error with a fallback message", () => {
    const result = projectSidecarAgentEvent("run-5", { type: "error" });
    expect(result).toEqual({
      type: "error",
      taskId: "run-5",
      runId: "run-5",
      content: "Agent error",
    });
  });

  test("drops user_message and unknown event types", () => {
    expect(projectSidecarAgentEvent("run-6", { type: "user_message" })).toBe(null);
    expect(projectSidecarAgentEvent("run-7", { type: "nonsense" })).toBe(null);
    expect(projectSidecarAgentEvent("run-8", null)).toBe(null);
    expect(projectSidecarAgentEvent("run-9", "string")).toBe(null);
  });
});

describe("SidecarClient", () => {
  test("connect sends auth.handshake with the injected token", async () => {
    const { socket } = await connectClient();
    const parsed = JSON.parse(socket.sent[0] ?? "{}") as {
      method?: string;
      params?: { token?: string };
    };
    expect(parsed.method).toBe("auth.handshake");
    expect(parsed.params?.token).toBe("test-token");
  });

  test("setWorkspace sends workspace.setCurrent and resolves with the canonical root", async () => {
    const { client, socket } = await connectClient();
    const promise = client.setWorkspace("/tmp/ws");
    await Promise.resolve();
    const request = lastSent(socket);
    expect(request.method).toBe("workspace.setCurrent");
    socket.receive(
      JSON.stringify({
        type: "response",
        requestId: request.requestId,
        ok: true,
        result: { workspaceRoot: "/tmp/ws" },
      }),
    );
    const result = await promise;
    expect(result.workspaceRoot).toBe("/tmp/ws");
  });

  test("rejects the pending promise when the response comes back with ok:false", async () => {
    const { client, socket } = await connectClient();
    const promise = client.setWorkspace("/bad");
    await Promise.resolve();
    const request = lastSent(socket);
    socket.receive(
      JSON.stringify({
        type: "response",
        requestId: request.requestId,
        ok: false,
        error: "forbidden root",
      }),
    );
    let thrown: Error | null = null;
    try {
      await promise;
    } catch (error) {
      thrown = error as Error;
    }
    expect(thrown?.message).toBe("forbidden root");
  });

  test("runAgent routes sidecar agent.event messages to the run's onEvent handler", async () => {
    const { client, socket } = await connectClient();
    const events: AgentTaskStreamEvent[] = [];
    const approvals: SidecarApprovalRequest[] = [];
    let doneRunId: string | null = null;
    let errorMessage: string | null = null;

    const runPromise = client.runAgent({
      prompt: "do the thing",
      apiKey: "sk-test",
      model: "claude-3-5-sonnet",
      onEvent: (event) => {
        events.push(event);
      },
      onApproval: (req) => {
        approvals.push(req);
      },
      onError: (msg) => {
        errorMessage = msg;
      },
      onDone: (runId) => {
        doneRunId = runId;
      },
    });

    await Promise.resolve();
    const request = lastSent(socket);
    expect(request.method).toBe("agent.run");
    socket.receive(
      JSON.stringify({
        type: "response",
        requestId: request.requestId,
        ok: true,
        result: { runId: "r1" },
      }),
    );

    const runId = await runPromise;
    expect(runId).toBe("r1");

    // First chunk of model output
    socket.receive(
      JSON.stringify({
        type: "event",
        event: "agent.event",
        data: { runId: "r1", event: { type: "text", content: "Hello " } },
      }),
    );
    // Tool start
    socket.receive(
      JSON.stringify({
        type: "event",
        event: "agent.event",
        data: {
          runId: "r1",
          event: { type: "tool_start", toolName: "Read", toolInput: { file_path: "a.ts" } },
        },
      }),
    );
    // Approval request for a sensitive command
    socket.receive(
      JSON.stringify({
        type: "event",
        event: "approval.request",
        data: {
          runId: "r1",
          toolUseId: "tu-1",
          toolName: "Bash",
          toolInput: { command: "rm foo" },
          decisionReason: "fs-modifying",
        },
      }),
    );
    // Done
    socket.receive(
      JSON.stringify({
        type: "event",
        event: "agent.event",
        data: { runId: "r1", event: { type: "done" } },
      }),
    );

    await Promise.resolve();

    expect(events.length).toBe(3); // text, tool_start, done
    expect(events[0]?.type).toBe("execution_event");
    expect(events[1]?.type).toBe("execution_event");
    expect(events[2]?.type).toBe("done");
    expect(approvals.length).toBe(1);
    expect(approvals[0]?.toolName).toBe("Bash");
    expect(approvals[0]?.decisionReason).toBe("fs-modifying");
    expect(doneRunId).toBe("r1");
    expect(errorMessage).toBe(null);
  });

  test("runAgent error events invoke onError and surface an error event", async () => {
    const { client, socket } = await connectClient();
    const events: AgentTaskStreamEvent[] = [];
    let errorMessage: string | null = null;

    const runPromise = client.runAgent({
      prompt: "go",
      apiKey: "sk-test",
      model: "claude-3-5",
      onEvent: (event) => {
        events.push(event);
      },
      onApproval: () => undefined,
      onError: (msg) => {
        errorMessage = msg;
      },
      onDone: () => undefined,
    });
    await Promise.resolve();
    socket.receive(
      JSON.stringify({
        type: "response",
        requestId: lastSent(socket).requestId,
        ok: true,
        result: { runId: "r-err" },
      }),
    );
    await runPromise;

    socket.receive(
      JSON.stringify({
        type: "event",
        event: "agent.event",
        data: {
          runId: "r-err",
          event: { type: "error", content: "upstream 401" },
        },
      }),
    );

    await Promise.resolve();
    expect(errorMessage).toBe("upstream 401");
    expect(events.some((e) => e.type === "error" && e.content === "upstream 401")).toBe(true);
  });

  test("events for an unknown runId are dropped instead of crashing", async () => {
    const { client, socket } = await connectClient();
    let errorMessage: string | null = null;
    const runPromise = client.runAgent({
      prompt: "go",
      apiKey: "sk-test",
      model: "m",
      onEvent: () => undefined,
      onApproval: () => undefined,
      onError: (msg) => {
        errorMessage = msg;
      },
      onDone: () => undefined,
    });
    await Promise.resolve();
    socket.receive(
      JSON.stringify({
        type: "response",
        requestId: lastSent(socket).requestId,
        ok: true,
        result: { runId: "mine" },
      }),
    );
    await runPromise;

    // Send an event for a run we did not register.
    socket.receive(
      JSON.stringify({
        type: "event",
        event: "agent.event",
        data: { runId: "someone-else", event: { type: "text", content: "x" } },
      }),
    );

    expect(errorMessage).toBe(null);
  });

  test("socket close rejects pending requests and surfaces a final error to active runs", async () => {
    const { client, socket } = await connectClient();
    let errorMessage: string | null = null;

    const runPromise = client.runAgent({
      prompt: "go",
      apiKey: "sk-test",
      model: "m",
      onEvent: () => undefined,
      onApproval: () => undefined,
      onError: (msg) => {
        errorMessage = msg;
      },
      onDone: () => undefined,
    });
    await Promise.resolve();
    socket.receive(
      JSON.stringify({
        type: "response",
        requestId: lastSent(socket).requestId,
        ok: true,
        result: { runId: "r2" },
      }),
    );
    await runPromise;

    // Queue a follow-up request and then slam the socket shut.
    const pending = client.cancelRun("r2");
    socket.forceClose();

    let rejected: Error | null = null;
    try {
      await pending;
    } catch (error) {
      rejected = error as Error;
    }

    expect(rejected?.message).toBe("sidecar connection closed");
    expect(errorMessage).toBe("sidecar connection closed");
  });
});
