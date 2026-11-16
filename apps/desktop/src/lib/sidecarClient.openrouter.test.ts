import { expect, test } from "bun:test";
import { SidecarClient, type SidecarWebSocketLike } from "./sidecarClient";

test("desktop serializes independent OpenRouter connection over agent.run without replacing model credentials", async () => {
  const frames: Array<{ method: string; params: Record<string, unknown> }> = [];
  const listeners = new Map<string, Set<(event: unknown) => void>>();
  const emit = (type: string, event: unknown) => {
    for (const listener of listeners.get(type) ?? []) listener(event);
  };
  const client = new SidecarClient({
    endpoint: { host: "127.0.0.1", port: 54321, token: "synthetic-handshake" },
    createSocket: () => {
      const socket: SidecarWebSocketLike = {
        readyState: 0,
        send(data) {
          const frame = JSON.parse(data);
          frames.push(frame);
          queueMicrotask(() =>
            emit("message", {
              data: JSON.stringify({
                type: "response",
                requestId: frame.requestId,
                ok: true,
                result: frame.method === "agent.run" ? { runId: "synthetic-run" } : { ok: true },
              }),
            }),
          );
        },
        close() {
          socket.readyState = 3;
          emit("close", {});
        },
        addEventListener(type, listener) {
          if (!listeners.has(type)) listeners.set(type, new Set());
          listeners.get(type)?.add(listener);
        },
        removeEventListener(type, listener) {
          listeners.get(type)?.delete(listener);
        },
      };
      queueMicrotask(() => {
        socket.readyState = 1;
        emit("open", {});
      });
      return socket;
    },
  });
  const connection = {
    baseUrl: "https://openrouter.ai/api/v1" as const,
    model: "deepseek/deepseek-v4-pro" as const,
    engine: "exa" as const,
    apiKey: "synthetic-retrieval-key",
  };
  try {
    await client.connect();
    const runId = await client.runAgent({
      prompt: "Synthetic docs",
      apiKey: "synthetic-answer-key",
      model: "answer-model",
      webSearchEnabled: true,
      searchProvider: "openrouter",
      openRouterSearchConnection: connection,
      targetMcpServer: "tavily-hikari",
      onEvent: () => {},
      onApproval: () => {},
      onError: () => {},
      onDone: () => {},
    });
    expect(runId).toBe("synthetic-run");
    const frame = frames.find((item) => item.method === "agent.run");
    expect(frame?.params.openRouterSearchConnection).toEqual(connection);
    expect(frame?.params.searchProvider).toBe("openrouter");
    expect(frame?.params.targetMcpServer).toBe("tavily-hikari");
    expect(frame?.params.apiKey).toBe("synthetic-answer-key");
    expect(frame?.params.prompt).toBe("Synthetic docs");
    expect(frame?.params.toolConnection).toBe(undefined);
  } finally {
    await client.close();
  }
});
