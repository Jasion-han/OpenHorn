import { expect, test } from "bun:test";
import type { SidecarClient, SidecarEndpoint } from "../lib/sidecarClient";
import { createDesktopSidecarStore, type SidecarPlatform } from "./sidecarStore";

const endpoint: SidecarEndpoint = { host: "127.0.0.1", port: 42, token: "fixture" };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
class Client {
  onDisconnect: (() => void) | null = null;
  closeCalls = 0;
  connectImpl = async () => {};
  workspaceImpl = async (root: string) => ({ workspaceRoot: root || "/default" });
  async connect() {
    await this.connectImpl();
  }
  async close() {
    this.closeCalls++;
  }
  async setWorkspace(root: string) {
    return this.workspaceImpl(root);
  }
}
function setup(overrides: Partial<SidecarPlatform> = {}, createClient = () => new Client()) {
  let starts = 0;
  let stops = 0;
  const clients: Client[] = [];
  const platform: SidecarPlatform = {
    startSidecar: async () => {
      starts++;
      return endpoint;
    },
    stopSidecar: async () => {
      stops++;
    },
    pickWorkspaceDir: async () => null,
    ...overrides,
  };
  const store = createDesktopSidecarStore({
    platform,
    createClient: () => {
      const client = createClient();
      clients.push(client);
      return client as unknown as SidecarClient;
    },
  });
  return { store, clients, starts: () => starts, stops: () => stops };
}
async function flush() {
  for (let i = 0; i < 15; i++) await Promise.resolve();
}
async function withTimers(
  run: (timers: Map<number, { callback: () => void; delay: number }>) => Promise<void>,
) {
  const originalSet = globalThis.setTimeout;
  const originalClear = globalThis.clearTimeout;
  const timers = new Map<number, { callback: () => void; delay: number }>();
  let id = 0;
  globalThis.setTimeout = ((...args: Parameters<typeof originalSet>) => {
    const [callback, delay] = args;
    timers.set(++id, { callback: () => (callback as () => void)(), delay: delay ?? 0 });
    return id;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((timer: ReturnType<typeof originalSet>) => {
    timers.delete(Number(timer));
  }) as typeof clearTimeout;
  try {
    await run(timers);
  } finally {
    globalThis.setTimeout = originalSet;
    globalThis.clearTimeout = originalClear;
  }
}

test("Stop during host startup cannot restore a ready client afterward", async () => {
  const gate = deferred<SidecarEndpoint>();
  const { store, clients } = setup({ startSidecar: () => gate.promise });
  const starting = store.getState().start();
  const stopping = store.getState().stop();
  gate.resolve(endpoint);
  await Promise.all([starting, stopping]);
  expect(store.getState().status).toBe("idle");
  expect(store.getState().client).toBe(null);
  expect(clients.length).toBe(0);
});

test("Stop disposes a connecting client and ignores its delayed handshake", async () => {
  const gate = deferred<void>();
  const client = new Client();
  client.connectImpl = () => gate.promise;
  const { store } = setup({}, () => client);
  const starting = store.getState().start();
  await flush();
  await store.getState().stop();
  gate.resolve();
  await starting;
  expect(store.getState().status).toBe("idle");
  expect(store.getState().client).toBe(null);
  expect(client.closeCalls).toBe(1);
});

test("Stop, reset and unsupported invalidate default workspace responses", async () => {
  for (const action of ["stop", "reset", "unsupported"] as const) {
    const gate = deferred<{ workspaceRoot: string }>();
    const client = new Client();
    client.workspaceImpl = () => gate.promise;
    const { store } = setup({}, () => client);
    const starting = store.getState().start();
    await flush();
    if (action === "stop") await store.getState().stop();
    else if (action === "reset") store.getState().reset();
    else store.getState().markUnsupported("fixture unsupported");
    gate.resolve({ workspaceRoot: "/late-old-root" });
    await starting;
    expect(store.getState().status).toBe(action === "unsupported" ? "unsupported" : "idle");
    expect(store.getState().workspaceRoot).toBe(null);
    expect(client.closeCalls).toBe(1);
  }
});

test("an old disconnected client cannot erase a replacement client", async () => {
  const { store, clients } = setup();
  await store.getState().start();
  const disconnected = clients[0].onDisconnect;
  store.getState().reset();
  await store.getState().start();
  disconnected?.();
  expect(store.getState().status).toBe("ready");
  expect(store.getState().client).toBe(clients[1] as unknown as SidecarClient);
  expect(clients[0].closeCalls).toBe(1);
  await store.getState().stop();
});

test("automatic recovery retries failed connections with bounded exponential backoff", async () => {
  await withTimers(async (timers) => {
    let created = 0;
    const { store, clients, starts } = setup({}, () => {
      const client = new Client();
      if (++created > 1)
        client.connectImpl = async () => {
          throw new Error("fixture offline");
        };
      return client;
    });
    await store.getState().start();
    clients[0].onDisconnect?.();
    const delays: number[] = [];
    while (timers.size) {
      const [id, timer] = [...timers][0];
      timers.delete(id);
      delays.push(timer.delay);
      timer.callback();
      await flush();
      if (delays.length > 12) throw new Error("Unbounded retry");
    }
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000, 30000, 30000]);
    expect(starts()).toBe(11);
    expect(store.getState().status).toBe("error");
    expect(clients.slice(1).every((client) => client.closeCalls === 1)).toBe(true);
    await store.getState().stop();
  });
});

test("automatic recovery continues after host startup fails and resets backoff on success", async () => {
  await withTimers(async (timers) => {
    let calls = 0;
    const { store, clients } = setup({
      startSidecar: async () => {
        if (++calls === 2) throw new Error("fixture spawn unavailable");
        return endpoint;
      },
    });
    await store.getState().start();
    clients[0].onDisconnect?.();
    for (let attempt = 0; attempt < 2; attempt++) {
      const next = [...timers][0];
      if (!next) break;
      timers.delete(next[0]);
      next[1].callback();
      await flush();
    }
    expect(calls).toBe(3);
    expect(store.getState().status).toBe("ready");
    clients[1]?.onDisconnect?.();
    expect([...timers.values()].map((timer) => timer.delay)).toEqual([1000]);
    await store.getState().stop();
    expect(timers.size).toBe(0);
  });
});

test("explicit lifecycle cancellation removes queued retries and ignores already queued callbacks", async () => {
  await withTimers(async (timers) => {
    for (const action of ["stop", "reset", "unsupported"] as const) {
      const { store, clients, starts } = setup();
      await store.getState().start();
      clients[0].onDisconnect?.();
      const stale = [...timers.values()][0]?.callback;
      if (action === "stop") await store.getState().stop();
      else if (action === "reset") store.getState().reset();
      else store.getState().markUnsupported("fixture unsupported");
      expect(timers.size).toBe(0);
      stale?.();
      await flush();
      expect(starts()).toBe(1);
    }
  });
});

test("a replacement start waits for the captured host stop before starting again", async () => {
  const gate = deferred<void>();
  const { store, starts } = setup({ stopSidecar: () => gate.promise });
  await store.getState().start();
  const stopping = store.getState().stop();
  const replacement = store.getState().start();
  await flush();
  expect(starts()).toBe(1);
  gate.resolve();
  await Promise.all([stopping, replacement]);
  expect(starts()).toBe(2);
  expect(store.getState().status).toBe("ready");
  store.getState().reset();
});

test("a repeated Stop invalidates a replacement queued behind the same host stop", async () => {
  const gate = deferred<void>();
  let stops = 0;
  const { store, starts } = setup({
    stopSidecar: () => {
      stops++;
      return gate.promise;
    },
  });
  await store.getState().start();
  const firstStop = store.getState().stop();
  const replacement = store.getState().start();
  await flush();
  const finalStop = store.getState().stop();
  gate.resolve();
  await Promise.all([firstStop, replacement, finalStop]);
  expect(stops).toBe(1);
  expect(starts()).toBe(1);
  expect(store.getState().status).toBe("idle");
  expect(store.getState().client).toBe(null);
});

test("a shared host stop failure belongs to the final Stop rather than its canceled replacement", async () => {
  let fail!: () => void;
  const gate = new Promise<void>((_resolve, reject) => {
    fail = () => reject(new Error("fixture stop failed"));
  });
  const { store, starts } = setup({ stopSidecar: () => gate });
  await store.getState().start();
  const firstStop = store.getState().stop();
  const replacement = store.getState().start();
  await flush();
  const finalStop = store.getState().stop();
  fail();
  await Promise.all([firstStop, replacement, finalStop]);
  expect(starts()).toBe(1);
  expect(store.getState().status).toBe("error");
  expect(store.getState().lastError).toBe("fixture stop failed");
  expect(store.getState().client).toBe(null);
});

test("late manual workspace results cannot change a replacement connection", async () => {
  for (const method of ["setWorkspace", "ensureWorkspace"] as const) {
    const { store, clients } = setup();
    await store.getState().start();
    const gate = deferred<{ workspaceRoot: string }>();
    clients[0].workspaceImpl = () => gate.promise;
    const setting = store.getState()[method]("/old-project");
    store.getState().reset();
    await store.getState().start();
    gate.resolve({ workspaceRoot: "/late-old-project" });
    const result = await setting;
    expect(store.getState().workspaceRoot).toBe("/default");
    if (method === "ensureWorkspace") expect(result).toBe(null);
    await store.getState().stop();
  }
});

test("a public ready-client injection supports workspace resolution and Stop cleanup", async () => {
  const client = new Client();
  const { store } = setup();
  store.setState({ status: "ready", client: client as unknown as SidecarClient });
  expect(await store.getState().ensureWorkspace("/injected")).toBe("/injected");
  expect(store.getState().workspaceRoot).toBe("/injected");
  await store.getState().stop();
  expect(client.closeCalls).toBe(1);
});
