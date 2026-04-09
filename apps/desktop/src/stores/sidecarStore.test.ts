import { describe, expect, test } from "bun:test";
import { SidecarClient, type SidecarEndpoint } from "../lib/sidecarClient";
import { createDesktopSidecarStore, type SidecarPlatform } from "./sidecarStore";

/**
 * Fake SidecarClient that records the methods the store drives. We do
 * NOT extend the real SidecarClient because we don't want the socket
 * machinery; we just need the subset the store calls.
 */
class FakeClient {
  connectImpl: () => Promise<void> = async () => undefined;
  setWorkspaceImpl: (root: string) => Promise<{ workspaceRoot: string }> = async (root) => ({
    workspaceRoot: root,
  });
  closeCalls = 0;
  connectCalls = 0;
  setWorkspaceCalls: string[] = [];

  async connect() {
    this.connectCalls += 1;
    await this.connectImpl();
  }

  async setWorkspace(root: string) {
    this.setWorkspaceCalls.push(root);
    return this.setWorkspaceImpl(root);
  }

  async close() {
    this.closeCalls += 1;
  }
}

function makePlatform(overrides: Partial<SidecarPlatform> = {}): {
  platform: SidecarPlatform;
  calls: { start: number; stop: number; pick: number };
} {
  const calls = { start: 0, stop: 0, pick: 0 };
  const platform: SidecarPlatform = {
    startSidecar: async () => {
      calls.start += 1;
      return { host: "127.0.0.1", port: 12345, token: "tok" };
    },
    stopSidecar: async () => {
      calls.stop += 1;
    },
    pickWorkspaceDir: async () => {
      calls.pick += 1;
      return "/tmp/ws";
    },
    ...overrides,
  };
  return { platform, calls };
}

function createStore(
  platformOverrides: Partial<SidecarPlatform> = {},
  fakeClient: FakeClient = new FakeClient(),
) {
  const { platform, calls } = makePlatform(platformOverrides);
  const store = createDesktopSidecarStore({
    platform,
    createClient: (_endpoint: SidecarEndpoint) =>
      // Bypass the real SidecarClient; the tests only care about the
      // store's state transitions and the methods it calls on us.
      fakeClient as unknown as SidecarClient,
  });
  return { store, platform, calls, fakeClient };
}

describe("sidecarStore", () => {
  test("initial state is idle with no endpoint", () => {
    const { store } = createStore();
    const state = store.getState();
    expect(state.status).toBe("idle");
    expect(state.endpoint).toBe(null);
    expect(state.client).toBe(null);
    expect(state.workspaceRoot).toBe(null);
    expect(state.lastError).toBe(null);
  });

  test("start goes through starting → connecting → ready on the happy path", async () => {
    const { store, fakeClient, calls } = createStore();
    const transitions: string[] = [];
    const unsubscribe = store.subscribe((s) => transitions.push(s.status));

    await store.getState().start();

    unsubscribe();
    expect(calls.start).toBe(1);
    expect(fakeClient.connectCalls).toBe(1);
    expect(store.getState().status).toBe("ready");
    expect(store.getState().endpoint?.port).toBe(12345);
    expect(store.getState().client).toBeDefined();
    // We should have seen starting → connecting → ready in order.
    expect(transitions).toEqual(["starting", "connecting", "ready"]);
  });

  test("start records an error when startSidecar IPC rejects", async () => {
    const fakeClient = new FakeClient();
    const { store } = createStore(
      {
        startSidecar: async () => {
          throw new Error("spawn failed");
        },
      },
      fakeClient,
    );

    await store.getState().start();

    const state = store.getState();
    expect(state.status).toBe("error");
    expect(state.lastError).toBe("spawn failed");
    expect(state.endpoint).toBe(null);
    expect(fakeClient.connectCalls).toBe(0);
  });

  test("start records an error when the handshake fails", async () => {
    const fakeClient = new FakeClient();
    fakeClient.connectImpl = async () => {
      throw new Error("bad token");
    };
    const { store } = createStore({}, fakeClient);

    await store.getState().start();

    const state = store.getState();
    expect(state.status).toBe("error");
    expect(state.lastError).toBe("bad token");
    // The endpoint is kept so UI can show "we spawned on port N but
    // the handshake failed".
    expect(state.endpoint?.port).toBe(12345);
    expect(state.client).toBe(null);
  });

  test("start is idempotent when the sidecar is already ready", async () => {
    const { store, calls } = createStore();
    await store.getState().start();
    await store.getState().start();
    expect(calls.start).toBe(1);
  });

  test("stop closes the client, stops the sidecar, and resets state", async () => {
    const fakeClient = new FakeClient();
    const { store, calls } = createStore({}, fakeClient);
    await store.getState().start();

    await store.getState().stop();

    expect(fakeClient.closeCalls).toBe(1);
    expect(calls.stop).toBe(1);
    const state = store.getState();
    expect(state.status).toBe("idle");
    expect(state.endpoint).toBe(null);
    expect(state.client).toBe(null);
  });

  test("pickAndSetWorkspace calls into the dialog, then the sidecar setWorkspace", async () => {
    const fakeClient = new FakeClient();
    const { store, calls } = createStore({}, fakeClient);
    await store.getState().start();

    const picked = await store.getState().pickAndSetWorkspace();

    expect(picked).toBe("/tmp/ws");
    expect(calls.pick).toBe(1);
    expect(fakeClient.setWorkspaceCalls).toEqual(["/tmp/ws"]);
    expect(store.getState().workspaceRoot).toBe("/tmp/ws");
  });

  test("pickAndSetWorkspace returns null and does not touch the sidecar when the user cancels", async () => {
    const fakeClient = new FakeClient();
    const { store } = createStore(
      {
        pickWorkspaceDir: async () => null,
      },
      fakeClient,
    );
    await store.getState().start();

    const result = await store.getState().pickAndSetWorkspace();

    expect(result).toBe(null);
    expect(fakeClient.setWorkspaceCalls).toEqual([]);
    expect(store.getState().workspaceRoot).toBe(null);
  });

  test("setWorkspace records lastError when the sidecar rejects the root", async () => {
    const fakeClient = new FakeClient();
    fakeClient.setWorkspaceImpl = async () => {
      throw new Error("Workspace root is not allowed: /etc");
    };
    const { store } = createStore({}, fakeClient);
    await store.getState().start();

    await store.getState().setWorkspace("/etc");

    expect(store.getState().lastError).toBe("Workspace root is not allowed: /etc");
    expect(store.getState().workspaceRoot).toBe(null);
  });

  test("setWorkspace is a no-op when the sidecar is not ready", async () => {
    const fakeClient = new FakeClient();
    const { store } = createStore({}, fakeClient);
    // Don't start — status is idle.
    await store.getState().setWorkspace("/tmp/ws");

    expect(fakeClient.setWorkspaceCalls).toEqual([]);
    expect(store.getState().lastError).toBe("sidecar not ready");
  });

  test("markUnsupported sets status to unsupported and records the reason", () => {
    const { store } = createStore();
    store.getState().markUnsupported("running outside Tauri");
    const state = store.getState();
    expect(state.status).toBe("unsupported");
    expect(state.lastError).toBe("running outside Tauri");
  });

  test("reset clears all state", async () => {
    const { store } = createStore();
    await store.getState().start();
    store.getState().reset();
    const state = store.getState();
    expect(state.status).toBe("idle");
    expect(state.endpoint).toBe(null);
    expect(state.client).toBe(null);
    expect(state.workspaceRoot).toBe(null);
    expect(state.lastError).toBe(null);
  });

  test("store created with null platform parks in unsupported status on start", async () => {
    const store = createDesktopSidecarStore({ platform: null });
    await store.getState().start();
    const state = store.getState();
    expect(state.status).toBe("unsupported");
    expect(typeof state.lastError).toBe("string");
  });

  test("attachPlatform swaps a null platform for a real one and unparks status", async () => {
    const store = createDesktopSidecarStore({ platform: null });

    // First start while platform is null → unsupported
    await store.getState().start();
    expect(store.getState().status).toBe("unsupported");

    // Attach a working platform — status should go back to idle so
    // start() can proceed.
    const calls = { start: 0 };
    const platform: SidecarPlatform = {
      startSidecar: async () => {
        calls.start += 1;
        return { host: "127.0.0.1", port: 42, token: "tok" };
      },
      stopSidecar: async () => undefined,
      pickWorkspaceDir: async () => null,
    };
    const fakeClient = new FakeClient();
    // Inject the fake client. We do this by temporarily recreating
    // the store through the public factory with attachPlatform(real)
    // mimicking what App bootstrap does.
    // Note: the store closes over createClient via its own options,
    // so for this test we just verify attachPlatform toggles status.
    store.getState().attachPlatform(platform);
    expect(store.getState().status).toBe("idle");
  });

  test("attachPlatform(null) flips a running-idle store to unsupported", () => {
    const { store } = createStore();
    expect(store.getState().status).toBe("idle");
    store.getState().attachPlatform(null, "running outside Tauri");
    expect(store.getState().status).toBe("unsupported");
    expect(store.getState().lastError).toBe("running outside Tauri");
  });
});
