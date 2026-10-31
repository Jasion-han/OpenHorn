/**
 * Parent-process watchdog.
 *
 * The Tauri host kills the sidecar on window close / app exit, but when the
 * host itself dies without running that cleanup (crash, kill -9, `tauri dev`
 * restarting after a Rust change) nothing tells the sidecar. The OS reparents
 * it (to launchd/init or a subreaper) and it keeps its loopback port and
 * memory forever.
 *
 * Detection: Bun caches `process.ppid` at startup (verified on 1.3.10 — it is
 * a plain value that keeps the dead parent's pid after reparenting), so
 * polling it alone never fires. Instead we probe the original parent pid with
 * signal 0: ESRCH means the parent no longer exists. A changed ppid is also
 * honoured in case the runtime ever reports the live value.
 *
 * Only enabled when the host opts in via OPENHORN_PARENT_WATCH=1, so a
 * sidecar started by hand (`bun run src/index.ts`, smoke scripts) never exits
 * just because its launching shell went away.
 */

export const PARENT_WATCH_ENV = "OPENHORN_PARENT_WATCH";
export const PARENT_WATCH_INTERVAL_MS = 2000;

export function isParentWatchEnabled(env: Record<string, string | undefined>): boolean {
  return env[PARENT_WATCH_ENV]?.trim() === "1";
}

export interface ParentProbe {
  /** `process.ppid` as currently reported by the runtime. */
  currentPpid: number;
  /**
   * Error code thrown by `process.kill(initialPpid, 0)`, or null when the
   * signal probe succeeded (the process exists).
   */
  probeErrorCode: string | null;
}

/**
 * True when the parent recorded at startup is gone. Conservative on purpose:
 * only a definite answer counts — the probe saying the pid doesn't exist
 * (ESRCH) or the runtime reporting a different ppid. EPERM or any other probe
 * error is treated as "still alive" so normal use never exits by mistake. An
 * initial ppid <= 1 (already orphaned at startup) is not a usable baseline.
 */
export function parentIsGone(initialPpid: number, probe: ParentProbe): boolean {
  if (!Number.isInteger(initialPpid) || initialPpid <= 1) return false;
  if (probe.probeErrorCode === "ESRCH") return true;
  return Number.isInteger(probe.currentPpid) && probe.currentPpid !== initialPpid;
}

function probeProcess(pid: number): string | null {
  try {
    process.kill(pid, 0);
    return null;
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    return typeof code === "string" ? code : "UNKNOWN";
  }
}

/**
 * Starts the watchdog. The timer is unref'd so it never keeps the process
 * alive on its own. `onParentGone` is called at most once.
 */
export function startParentWatchdog(
  onParentGone: () => void,
  options: {
    initialPpid?: number;
    readPpid?: () => number;
    probe?: (pid: number) => string | null;
    intervalMs?: number;
  } = {},
): () => void {
  const readPpid = options.readPpid ?? (() => process.ppid);
  const probe = options.probe ?? probeProcess;
  const initialPpid = options.initialPpid ?? readPpid();
  const timer = setInterval(() => {
    const gone = parentIsGone(initialPpid, {
      currentPpid: readPpid(),
      probeErrorCode: probe(initialPpid),
    });
    if (gone) {
      clearInterval(timer);
      onParentGone();
    }
  }, options.intervalMs ?? PARENT_WATCH_INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
