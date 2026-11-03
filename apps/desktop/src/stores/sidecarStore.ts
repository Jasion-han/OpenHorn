import { create } from "zustand";
import { SidecarClient, type SidecarEndpoint } from "../lib/sidecarClient";

/**
 * State machine for the sidecar runtime lifecycle.
 *
 *   idle        → the user has not yet started the sidecar
 *   starting    → Tauri start_sidecar IPC is in progress
 *   connecting  → the binary is running; we are handshaking the WS
 *   ready       → handshake succeeded; the sidecar is usable
 *   unsupported → the host platform cannot run the sidecar (e.g. running
 *                 inside a non-Tauri browser, or the binary is missing)
 *   error       → a previous start / connect / handshake attempt failed;
 *                 see `lastError` for the reason
 */
export type SidecarStatus = "idle" | "starting" | "connecting" | "ready" | "unsupported" | "error";

/**
 * Platform bridge the store needs to reach Tauri IPC. Defined as an
 * interface so unit tests can inject a deterministic fake instead of
 * poking at the real @tauri-apps/api/core.
 */
export interface SidecarPlatform {
  startSidecar: () => Promise<SidecarEndpoint>;
  stopSidecar: () => Promise<void>;
  pickWorkspaceDir: () => Promise<string | null>;
}

/**
 * ClientFactory is the seam for tests to hand back a pre-wired
 * SidecarClient rather than constructing a real WebSocket.
 */
export type SidecarClientFactory = (endpoint: SidecarEndpoint) => SidecarClient;

const defaultClientFactory: SidecarClientFactory = (endpoint) => new SidecarClient({ endpoint });

export interface SidecarState {
  status: SidecarStatus;
  endpoint: SidecarEndpoint | null;
  client: SidecarClient | null;
  workspaceRoot: string | null;
  lastError: string | null;

  /**
   * Attaches a platform bridge. Call this once from App bootstrap
   * (after dynamically importing @tauri-apps/api) so the rest of the
   * app can keep referring to the singleton store.
   */
  attachPlatform: (platform: SidecarPlatform | null, reason?: string) => void;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  pickAndSetWorkspace: () => Promise<string | null>;
  setWorkspace: (root: string) => Promise<void>;
  /**
   * Guarantees a workspace root is set before a run, falling back to the saved
   * one or to the sidecar-resolved default. Without this, a failed/raced
   * default-workspace setup leaves workspaceRoot null, which silently drops
   * Agent Skills.
   *
   * `rootOverride` is the per-conversation folder (a sidebar project). It is
   * pushed to the sidecar for this run only and is NOT persisted as the user's
   * default workspace — the next plain conversation falls back to the saved one.
   * Returns this call's resolved root, or null on failure/unready. An older
   * store root cannot stand in for a failed resolution of this run's directory.
   */
  ensureWorkspace: (rootOverride?: string | null) => Promise<string | null>;
  markUnsupported: (reason: string) => void;
  reset: () => void;
}

const WORKSPACE_STORAGE_KEY = "openhorn.sidecar.workspaceRoot";

const INITIAL_STATE: Pick<
  SidecarState,
  "status" | "endpoint" | "client" | "workspaceRoot" | "lastError"
> = {
  status: "idle",
  endpoint: null,
  client: null,
  workspaceRoot: null,
  lastError: null,
};

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error.trim()) return error.trim();
  return "sidecar error";
}

export interface CreateSidecarStoreOptions {
  /**
   * Platform bridge. Pass `null` to indicate the host cannot run the
   * sidecar (non-Tauri environment). In that case `start()` transitions
   * to "unsupported" instead of attempting to spawn anything.
   */
  platform: SidecarPlatform | null;
  createClient?: SidecarClientFactory;
  /**
   * Human-readable reason to show when platform is null.
   */
  unsupportedReason?: string;
}

export function createDesktopSidecarStore(options: CreateSidecarStoreOptions) {
  // `platform` is mutable so App bootstrap can swap in the real Tauri
  // bridge after dynamically importing @tauri-apps/api. The store is
  // constructed at module load time with platform=null and the bridge
  // calls `attachPlatform` once it's resolved.
  let platform: SidecarPlatform | null = options.platform;
  const createClient = options.createClient ?? defaultClientFactory;
  let unsupportedReason =
    options.unsupportedReason ?? "sidecar runtime is only available inside the desktop shell";

  // Auto-reconnect bookkeeping. Kept in the store closure (not module scope) so
  // each store instance — including test instances — has its own state.
  const BASE_RECONNECT_DELAY_MS = 1000;
  const MAX_RECONNECT_DELAY_MS = 30_000;
  const MAX_RECONNECT_ATTEMPTS = 10;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectAttempts = 0;
  let recovering = false;
  let generation = 0;
  let managedClient: SidecarClient | null = null;
  let stopPromise: Promise<void> | null = null;
  let stopOwner = 0;
  const hostStarts = new Set<Promise<SidecarEndpoint>>();

  const clearReconnectTimer = () => {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };

  return create<SidecarState>((set, get) => {
    const disposeClient = (client: SidecarClient) => {
      client.onDisconnect = null;
      void client.close().catch(() => {});
    };
    const invalidate = () => {
      generation++;
      clearReconnectTimer();
      reconnectAttempts = 0;
      recovering = false;
      for (const client of new Set([managedClient, get().client])) {
        if (client) disposeClient(client);
      }
      managedClient = null;
      return generation;
    };
    const scheduleReconnect = (owner: number, capturedPlatform: SidecarPlatform) => {
      if (!recovering || generation !== owner || platform !== capturedPlatform) return;
      clearReconnectTimer();
      if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        recovering = false;
        set({ status: "error", client: null, lastError: "sidecar 连接断开，重连失败" });
        return;
      }
      const delay = Math.min(
        BASE_RECONNECT_DELAY_MS * 2 ** reconnectAttempts,
        MAX_RECONNECT_DELAY_MS,
      );
      reconnectAttempts++;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        if (
          generation === owner &&
          platform === capturedPlatform &&
          recovering &&
          get().status === "error"
        ) {
          void get().start();
        }
      }, delay);
    };
    const ownsClient = (owner: number, client: SidecarClient) =>
      generation === owner && get().client === client && get().status === "ready";

    return {
      ...INITIAL_STATE,

      attachPlatform(nextPlatform, reason) {
        if (reason) unsupportedReason = reason;
        if (platform !== nextPlatform) {
          invalidate();
          platform = nextPlatform;
          set({
            ...INITIAL_STATE,
            status: nextPlatform ? "idle" : "unsupported",
            lastError: nextPlatform ? null : unsupportedReason,
          });
        } else if (nextPlatform === null) {
          invalidate();
          set({ ...INITIAL_STATE, status: "unsupported", lastError: unsupportedReason });
        } else if (get().status === "unsupported") {
          set({ status: "idle", lastError: null });
        }
      },

      async start() {
        const current = get().status;
        if (
          current === "ready" ||
          current === "starting" ||
          current === "connecting" ||
          current === "unsupported"
        )
          return;
        const capturedPlatform = platform;
        if (!capturedPlatform) {
          set({ status: "unsupported", lastError: unsupportedReason });
          return;
        }
        const owner = ++generation;
        const ownsAttempt = () => generation === owner && platform === capturedPlatform;
        clearReconnectTimer();
        set({ status: "starting", lastError: null });
        // Do not let a previous stop terminate the child created by this start.
        if (stopPromise) await stopPromise;
        if (!ownsAttempt()) return;
        let endpoint: SidecarEndpoint;
        try {
          const starting = capturedPlatform.startSidecar();
          hostStarts.add(starting);
          try {
            endpoint = await starting;
          } finally {
            hostStarts.delete(starting);
          }
        } catch (error) {
          if (!ownsAttempt()) return;
          set({ status: "error", lastError: toErrorMessage(error) });
          scheduleReconnect(owner, capturedPlatform);
          return;
        }
        if (!ownsAttempt()) return;
        set({ status: "connecting", endpoint });
        const client = createClient(endpoint);
        managedClient = client;
        try {
          await client.connect();
        } catch (error) {
          if (!ownsAttempt() || managedClient !== client) return;
          managedClient = null;
          disposeClient(client);
          set({ status: "error", lastError: toErrorMessage(error), endpoint, client: null });
          scheduleReconnect(owner, capturedPlatform);
          return;
        }
        if (!ownsAttempt() || managedClient !== client) return;
        client.onDisconnect = () => {
          if (!ownsClient(owner, client) || platform !== capturedPlatform) return;
          managedClient = null;
          disposeClient(client);
          recovering = true;
          set({
            status: "error",
            client: null,
            workspaceRoot: null,
            lastError: "sidecar 连接断开，正在重连...",
          });
          scheduleReconnect(owner, capturedPlatform);
        };
        clearReconnectTimer();
        reconnectAttempts = 0;
        recovering = false;
        set({ status: "ready", client });
        let saved: string | null = null;
        try {
          saved = localStorage.getItem(WORKSPACE_STORAGE_KEY);
        } catch {}
        try {
          const result = await client.setWorkspace(saved || "");
          if (ownsClient(owner, client)) set({ workspaceRoot: result.workspaceRoot });
        } catch (error) {
          if (ownsClient(owner, client)) set({ lastError: toErrorMessage(error) });
        }
      },

      async stop() {
        const capturedPlatform = platform;
        const pendingStarts = [...hostStarts];
        stopOwner = invalidate();
        set({ ...INITIAL_STATE });
        // Every Stop invalidates queued replacement starts, even when the host
        // shutdown itself is already in flight and can be shared.
        if (stopPromise) return stopPromise;
        const stopping = (async () => {
          // An already-issued IPC can still spawn after local cancellation.
          // Stop that captured host only after all such requests have settled.
          await Promise.allSettled(pendingStarts);
          if (!capturedPlatform) return;
          try {
            await capturedPlatform.stopSidecar();
          } catch (error) {
            if (generation === stopOwner && platform === capturedPlatform) {
              set({ ...INITIAL_STATE, status: "error", lastError: toErrorMessage(error) });
            }
          }
        })();
        const completion = stopping.finally(() => {
          if (stopPromise === completion) stopPromise = null;
        });
        stopPromise = completion;
        return completion;
      },

      async pickAndSetWorkspace() {
        if (platform === null) {
          set({ lastError: unsupportedReason });
          return null;
        }
        const capturedPlatform = platform;
        const owner = generation;
        let root: string | null;
        try {
          root = await capturedPlatform.pickWorkspaceDir();
        } catch (error) {
          if (generation === owner && platform === capturedPlatform)
            set({ lastError: toErrorMessage(error) });
          return null;
        }
        if (!root || generation !== owner || platform !== capturedPlatform) return null;
        await get().setWorkspace(root);
        return generation === owner && platform === capturedPlatform ? root : null;
      },

      async setWorkspace(root) {
        const { client, status } = get();
        const owner = generation;
        if (status !== "ready" || !client) {
          set({ lastError: "sidecar not ready" });
          return;
        }
        try {
          const result = await client.setWorkspace(root);
          if (!ownsClient(owner, client)) return;
          set({ workspaceRoot: result.workspaceRoot, lastError: null });
          try {
            localStorage.setItem(WORKSPACE_STORAGE_KEY, result.workspaceRoot);
          } catch {}
        } catch (error) {
          if (ownsClient(owner, client)) set({ lastError: toErrorMessage(error) });
        }
      },

      async ensureWorkspace(rootOverride) {
        const { client, status } = get();
        const owner = generation;
        const override = rootOverride?.trim() || null;
        // Pick the target: the per-conversation override, else the saved default,
        // else let the sidecar resolve its default (empty string). The store's
        // current value is deliberately not consulted: it may hold a previous
        // run's project override, which must not leak into a plain conversation.
        let target = override;
        if (!target) {
          try {
            target = localStorage.getItem(WORKSPACE_STORAGE_KEY);
          } catch {}
          target = target || "";
        }
        // Resolve through the sidecar before every run. A restart can invalidate
        // the remembered root, and the store may hold another project's override.
        // Only this request's successful result may become the new run's cwd.
        if (status === "ready" && client) {
          try {
            const result = await client.setWorkspace(target);
            if (!ownsClient(owner, client)) return null;
            set({ workspaceRoot: result.workspaceRoot, lastError: null });
            if (!override) {
              try {
                localStorage.setItem(WORKSPACE_STORAGE_KEY, result.workspaceRoot);
              } catch {}
            }
            return result.workspaceRoot;
          } catch (error) {
            // Neither a project nor the default may reuse an older successful
            // root after this resolution failed: each run needs its own result.
            if (ownsClient(owner, client)) set({ lastError: toErrorMessage(error) });
            return null;
          }
        }
        return null;
      },

      markUnsupported(reason) {
        invalidate();
        set({ ...INITIAL_STATE, status: "unsupported", lastError: reason });
      },

      reset() {
        invalidate();
        set({ ...INITIAL_STATE });
      },
    };
  });
}

/**
 * Default global sidecar store. Starts with no platform attached; the
 * App component's bootstrap effect calls `attachPlatform` once the
 * Tauri bridge is resolved. Outside of Tauri (e.g. `pnpm dev:ui` in a
 * plain browser), the bootstrap leaves platform as null which parks
 * the store in the `unsupported` status — UI components can key off
 * that to disable the "run locally" switch.
 */
export const useSidecarStore = createDesktopSidecarStore({ platform: null });
