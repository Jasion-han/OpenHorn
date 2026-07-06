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
   * one or the default (/tmp). Without this, a failed/raced default-workspace
   * setup leaves workspaceRoot null, which silently drops Agent Skills and
   * makes the sidecar cwd fall back to the home directory.
   */
  ensureWorkspace: () => Promise<string | null>;
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

  const clearReconnectTimer = () => {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };

  return create<SidecarState>((set, get) => ({
    ...INITIAL_STATE,

    attachPlatform(nextPlatform, reason) {
      platform = nextPlatform;
      if (reason) unsupportedReason = reason;
      // If we previously flipped to "unsupported" because no platform
      // was attached, give the caller an "idle" slot back when they
      // attach a real platform.
      if (nextPlatform !== null && get().status === "unsupported") {
        set({ status: "idle", lastError: null });
      }
      if (nextPlatform === null && get().status !== "unsupported") {
        set({ status: "unsupported", lastError: unsupportedReason });
      }
    },

    async start() {
      const current = get().status;
      // Idempotent: if the sidecar is already ready, do nothing.
      if (current === "ready") return;
      // Refuse to race two start calls.
      if (current === "starting" || current === "connecting") return;
      // Refuse to start when the host doesn't support the sidecar.
      if (current === "unsupported") return;
      if (platform === null) {
        set({ status: "unsupported", lastError: unsupportedReason });
        return;
      }

      set({ status: "starting", lastError: null });

      let endpoint: SidecarEndpoint;
      try {
        endpoint = await platform.startSidecar();
      } catch (error) {
        set({ status: "error", lastError: toErrorMessage(error) });
        return;
      }

      set({ status: "connecting", endpoint });
      const client = createClient(endpoint);
      try {
        await client.connect();
      } catch (error) {
        // Spawned but could not handshake: leave the child alone and
        // surface the error. A follow-up start() call will try again.
        set({
          status: "error",
          lastError: toErrorMessage(error),
          endpoint,
          client: null,
        });
        return;
      }

      client.onDisconnect = () => {
        const current = get().status;
        if (current !== "ready") return;
        clearReconnectTimer();
        if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
          set({ status: "error", client: null, lastError: "sidecar 连接断开，重连失败" });
          return;
        }
        // Exponential backoff (1s, 2s, 4s … capped at 30s) instead of a fixed
        // 1s hammer, with a hard attempt cap so an unavailable sidecar doesn't
        // spin forever.
        const delay = Math.min(
          BASE_RECONNECT_DELAY_MS * 2 ** reconnectAttempts,
          MAX_RECONNECT_DELAY_MS,
        );
        reconnectAttempts += 1;
        set({ status: "error", client: null, lastError: "sidecar 连接断开，正在重连..." });
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          if (get().status === "error") {
            void get().start();
          }
        }, delay);
      };

      // Connected successfully — reset the backoff counter and cancel any
      // pending reconnect from a previous drop.
      clearReconnectTimer();
      reconnectAttempts = 0;
      set({ status: "ready", client });

      try {
        const saved = localStorage.getItem(WORKSPACE_STORAGE_KEY);
        const targetDir = saved || "/tmp";
        const result = await client.setWorkspace(targetDir);
        set({ workspaceRoot: result.workspaceRoot });
      } catch {}
    },

    async stop() {
      // Cancel any pending auto-reconnect so a queued timer can't resurrect the
      // sidecar after an explicit stop.
      clearReconnectTimer();
      reconnectAttempts = 0;
      const { client } = get();
      if (client) {
        try {
          await client.close();
        } catch {
          // best effort
        }
      }
      if (platform === null) {
        // Nothing to stop at the platform level; just drop local state.
        set({ ...INITIAL_STATE });
        return;
      }
      try {
        await platform.stopSidecar();
      } catch (error) {
        // Even if stop IPC fails, drop the local handle so the next
        // start() builds a fresh one.
        set({
          ...INITIAL_STATE,
          status: "error",
          lastError: toErrorMessage(error),
        });
        return;
      }
      set({ ...INITIAL_STATE });
    },

    async pickAndSetWorkspace() {
      if (platform === null) {
        set({ lastError: unsupportedReason });
        return null;
      }
      let root: string | null;
      try {
        root = await platform.pickWorkspaceDir();
      } catch (error) {
        set({ lastError: toErrorMessage(error) });
        return null;
      }
      if (!root) return null;
      await get().setWorkspace(root);
      return root;
    },

    async setWorkspace(root) {
      const { client, status } = get();
      if (status !== "ready" || !client) {
        set({ lastError: "sidecar not ready" });
        return;
      }
      try {
        const result = await client.setWorkspace(root);
        set({ workspaceRoot: result.workspaceRoot, lastError: null });
        try {
          localStorage.setItem(WORKSPACE_STORAGE_KEY, result.workspaceRoot);
        } catch {}
      } catch (error) {
        set({ lastError: toErrorMessage(error) });
      }
    },

    async ensureWorkspace() {
      const { client, status } = get();
      // Pick the target: current store value, else the saved one, else /tmp.
      let target = get().workspaceRoot;
      if (!target) {
        try {
          target = localStorage.getItem(WORKSPACE_STORAGE_KEY);
        } catch {}
        target = target || "/tmp";
      }
      // ALWAYS re-push to the sidecar before a run. The sidecar may have
      // restarted and reset its workspace to null (cwd then falls back to the
      // home dir) while the desktop store kept a stale value — the two diverge,
      // and Agent Skills silently vanish because the materialized skillsRoot no
      // longer matches the sidecar's cwd. Re-syncing keeps them in lockstep.
      if (status === "ready" && client) {
        try {
          const result = await client.setWorkspace(target);
          set({ workspaceRoot: result.workspaceRoot, lastError: null });
          try {
            localStorage.setItem(WORKSPACE_STORAGE_KEY, result.workspaceRoot);
          } catch {}
          return result.workspaceRoot;
        } catch {}
      }
      return get().workspaceRoot;
    },

    markUnsupported(reason) {
      set({ status: "unsupported", lastError: reason });
    },

    reset() {
      set({ ...INITIAL_STATE });
    },
  }));
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
