import { expect, test } from "bun:test";
import {
  SidecarClient,
  SidecarFeatureUnavailableError,
  type SidecarWebSocketLike,
} from "./sidecarClient";

function createFixture(modern: boolean) {
  const frames: Array<{ method: string; params: Record<string, unknown> }> = [];
  const listeners = new Map<string, Set<(event: unknown) => void>>();
  const emit = (type: string, event: unknown) => {
    for (const listener of listeners.get(type) ?? []) listener(event);
  };
  const client = new SidecarClient({
    endpoint: { host: "127.0.0.1", port: 54321, token: "synthetic-token" },
    createSocket: () => {
      const socket: SidecarWebSocketLike = {
        readyState: 0,
        send(raw) {
          const frame = JSON.parse(raw);
          frames.push(frame);
          queueMicrotask(() =>
            emit("message", {
              data: JSON.stringify({
                type: "response",
                requestId: frame.requestId,
                ok: true,
                result:
                  frame.method === "auth.handshake"
                    ? {
                        ok: true,
                        ...(modern ? { features: { research: 1, documentInput: 1 } } : {}),
                      }
                    : { runId: "synthetic" },
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
  const input = {
    prompt: "Research evidence",
    apiKey: "synthetic-answer",
    model: "gpt-4o",
    webSearchEnabled: true,
    onEvent() {},
    onApproval() {},
    onError() {},
    onDone() {},
  };
  return {
    client,
    frames,
    input,
    emitAgent: (event: Record<string, unknown>) =>
      emit("message", {
        data: JSON.stringify({
          type: "event",
          event: "agent.event",
          data: { runId: "synthetic", event },
        }),
      }),
  };
}

test("research and document flags are transmitted only after an explicit runtime capability handshake", async () => {
  const { client, frames, input } = createFixture(true);
  try {
    await client.connect();
    expect(client.supportsResearch).toBe(true);
    expect(client.supportsDocumentInput).toBe(true);
    await client.runAgent({ ...input, research: true });
    await client.runAgent({ ...input, documentInput: true });
    const runs = frames.filter((frame) => frame.method === "agent.run");
    expect(runs[0].params.research).toBe(true);
    expect(runs[1].params.documentInput).toBe(true);
  } finally {
    await client.close();
  }
});

test("an older sidecar cannot silently turn research into unrestricted ordinary Agent mode", async () => {
  const { client, frames, input } = createFixture(false);
  try {
    await client.connect();
    let error: unknown;
    try {
      await client.runAgent({ ...input, research: true });
    } catch (cause) {
      error = cause;
    }
    expect(error instanceof SidecarFeatureUnavailableError).toBe(true);
    try {
      await client.runAgent({ ...input, documentInput: true });
    } catch (cause) {
      error = cause;
    }
    expect(
      error instanceof SidecarFeatureUnavailableError && error.feature === "documentInput",
    ).toBe(true);
    expect(frames.filter((frame) => frame.method === "agent.run")).toHaveLength(0);
    await client.runAgent(input);
    expect(frames.filter((frame) => frame.method === "agent.run")).toHaveLength(1);
  } finally {
    await client.close();
  }
});

test("research terminal error/done releases callbacks so disconnect cannot re-fail a finished turn", async () => {
  const f = createFixture(true);
  const errors: string[] = [];
  let finished = 0;
  await f.client.connect();
  await f.client.runAgent({
    ...f.input,
    research: true,
    onError: (message) => errors.push(message),
    onDone: () => {
      finished++;
    },
  });
  f.emitAgent({ type: "error", errorCode: "research_no_sources", content: "research_no_sources" });
  f.emitAgent({ type: "done" });
  f.emitAgent({ type: "text", content: "late output must be discarded" });
  await f.client.close();
  expect(errors).toEqual(["research_no_sources"]);
  expect(finished).toBe(0);
});

test("research cancel acknowledgement plus terminal done leaves no callbacks for socket close", async () => {
  const f = createFixture(true);
  let errors = 0,
    finished = 0;
  await f.client.connect();
  await f.client.runAgent({
    ...f.input,
    research: true,
    onError: () => {
      errors++;
    },
    onDone: () => {
      finished++;
    },
  });
  await f.client.cancelRun("synthetic");
  f.emitAgent({ type: "done" });
  await f.client.close();
  expect(errors).toBe(0);
  expect(finished).toBe(1);
});
