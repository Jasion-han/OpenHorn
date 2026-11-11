import { create } from "zustand";
import { getDesktopBackendBase } from "../lib/backendBase";

/** Transport reachability, as last observed by any server request. */
export type BackendStatus = "unknown" | "ok" | "down";

export const HEALTH_URL = `${getDesktopBackendBase()}/`;
/**
 * Fired after a *recovery* — the full server state has been reloaded following
 * a period where the server was unreachable. Components that keep server data
 * in local state (settings panels) re-fetch on it; everything held in stores is
 * already reloaded by then.
 */
export const BACKEND_UP_EVENT = "openhorn:backend-up";

/**
 * Backoff between automatic reconnect probes. Each probe is one cheap GET; the
 * cap keeps a long outage at two requests a minute.
 */
export const RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 20_000, 30_000] as const;

export function reconnectDelay(attempt: number): number {
  const index = Math.min(Math.max(attempt, 0), RECONNECT_DELAYS_MS.length - 1);
  return RECONNECT_DELAYS_MS[index];
}

/**
 * Whether what is on screen is real server data and server writes may proceed.
 * "Never loaded" and "unreachable" both say no: defaults must not pass for data,
 * and a write against a dead server either fails or — worse — lands while the
 * UI still shows the empty offline view (that is how an empty conversation got
 * created during an outage).
 */
export function isServerReady(state: {
  status: BackendStatus;
  loaded: boolean;
  loading?: boolean;
}): boolean {
  return state.status === "ok" && state.loaded && !state.loading;
}

/**
 * What to tell the user instead of showing data: null when ready, "unavailable"
 * while the server is known to be unreachable, "connecting" otherwise (first
 * load still running, or reachable again and reloading).
 */
export function serverConnectionNotice(state: {
  status: BackendStatus;
  loaded: boolean;
  loading?: boolean;
}): "connecting" | "unavailable" | null {
  if (isServerReady(state)) return null;
  return state.status === "down" ? "unavailable" : "connecting";
}

export type ProbeResult = { ok: true } | { ok: false; message: string };

export interface BackendStatusDeps {
  probe?: () => Promise<ProbeResult>;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  now?: () => number;
}

export interface ServerConnectionConfig {
  /**
   * Loads every piece of server-backed state. Network failures are observed
   * through `markDown` (the request layer reports them); a throw also counts as
   * a failed load.
   */
  loader: () => Promise<void>;
  /** Called after a load that follows an outage (not after the first clean start). */
  onReconnected?: () => void;
}

export interface BackendStatusState {
  status: BackendStatus;
  /** Required server datasets are complete for this identity/load; cached data may remain while false. */
  loaded: boolean;
  /** A full load is in flight. */
  loading: boolean;
  lastError: string | null;
  lastDownAt: number | null;
  lastUpAt: number | null;
  /** Automatic reconnect probes made since the last successful load. */
  reconnectAttempt: number;
  markDown: (message: string) => void;
  markUp: () => void;
  /** Manual "Retry": probe now; on success run the full load. Resolves true once fully loaded. */
  retry: () => Promise<boolean>;
  /** The single entry point for loading server state. Concurrent calls share one load. */
  connect: () => Promise<boolean>;
  /** Wires the loader and starts the first load. Until then the store only records status. */
  start: (config: ServerConnectionConfig) => Promise<boolean>;
  /** Detaches the loader and cancels any pending probe (tests / teardown). */
  stop: () => void;
}

async function defaultProbe(): Promise<ProbeResult> {
  try {
    const response = await fetch(HEALTH_URL, {
      method: "GET",
      cache: "no-store",
      credentials: "include",
    });
    if (!response.ok) return { ok: false, message: `Health check failed (${response.status})` };
    return { ok: true };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Failed to fetch" };
  }
}

export function createBackendStatusStore(deps: BackendStatusDeps = {}) {
  const probe = deps.probe ?? defaultProbe;
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer =
    deps.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const now = deps.now ?? (() => Date.now());

  let config: ServerConnectionConfig | null = null;
  let inflight: Promise<boolean> | null = null;
  let timer: unknown = null;
  // Set by any observed outage; cleared by a full load that saw none. While set,
  // the next sign of life triggers a full reload.
  let needsReload = false;
  // Monotonic count of observed network failures, so a load can tell whether
  // any of its own requests failed even if a later one succeeded.
  let downEvents = 0;

  return create<BackendStatusState>((set, get) => {
    const cancelTimer = () => {
      if (timer !== null) {
        clearTimer(timer);
        timer = null;
      }
    };

    const probeAndRecover = async (): Promise<boolean> => {
      const result = await probe();
      if (!result.ok) {
        get().markDown(result.message);
        return false;
      }
      get().markUp();
      return true;
    };

    // Auto-reconnect only runs once the app has started the connection; before
    // that (and in tests that never start it) the store is a passive recorder.
    const ensureTimer = () => {
      if (!config || timer !== null) return;
      const attempt = get().reconnectAttempt;
      set({ reconnectAttempt: attempt + 1 });
      timer = setTimer(() => {
        timer = null;
        void probeAndRecover();
      }, reconnectDelay(attempt));
    };

    return {
      status: "unknown",
      loaded: false,
      loading: false,
      lastError: null,
      lastDownAt: null,
      lastUpAt: null,
      reconnectAttempt: 0,

      markDown: (message) => {
        downEvents += 1;
        needsReload = true;
        set({ status: "down", lastError: message, lastDownAt: now() });
        ensureTimer();
      },

      markUp: () => {
        set({ status: "ok", lastError: null, lastUpAt: now() });
        // Any successful response after an outage (or before the first load
        // finished) is the cue to reload everything — not just whatever the
        // caller happened to fetch.
        if (config && !inflight && (needsReload || !get().loaded)) {
          void get().connect();
        }
      },

      retry: async () => {
        cancelTimer();
        const reachable = await probeAndRecover();
        if (!reachable) return false;
        if (!config) return true;
        const pending: Promise<boolean> | null = inflight;
        if (pending) return pending;
        return isServerReady(get());
      },

      connect: () => {
        if (inflight) return inflight;
        const current = config;
        if (!current) return Promise.resolve(false);
        const recovering = needsReload;
        const downBefore = downEvents;
        set({ loading: true });
        const execute = async (): Promise<boolean> => {
          let threw = false;
          try {
            await current.loader();
          } catch {
            threw = true;
          }
          const ok = !threw && downEvents === downBefore && get().status !== "down";
          if (!ok) {
            set({ loading: false, loaded: false });
            needsReload = true;
            ensureTimer();
            return false;
          }
          needsReload = false;
          cancelTimer();
          set({
            status: "ok",
            lastError: null,
            loaded: true,
            loading: false,
            reconnectAttempt: 0,
          });
          if (recovering) current.onReconnected?.();
          return true;
        };
        // `inflight` must be set before the loader starts: its requests report
        // back synchronously-ish through markUp, which must see the load running
        // rather than start another one.
        const run: Promise<boolean> = Promise.resolve()
          .then(execute)
          .finally(() => {
            if (inflight === run) inflight = null;
          });
        inflight = run;
        return run;
      },

      start: (next) => {
        config = next;
        return get().connect();
      },

      stop: () => {
        config = null;
        cancelTimer();
      },
    };
  });
}

export const useBackendStatusStore = createBackendStatusStore();

// A hot-replaced copy of this module starts its own connection; the old one
// must not keep probing (and reloading into stale stores) in the background.
import.meta.hot?.dispose(() => useBackendStatusStore.getState().stop());
