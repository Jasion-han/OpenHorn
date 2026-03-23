export const AGENT_FIRST_OUTPUT_TIMEOUT_MS = 20_000;
export const AGENT_IDLE_TIMEOUT_MS = 120_000;
export const AGENT_TOTAL_TIMEOUT_MS = 900_000;

function abortSafely(controller: AbortController, reason: string) {
  try {
    if (!controller.signal.aborted) {
      controller.abort(reason);
    }
  } catch {
    // ignore
  }
}

export function formatTimeoutSeconds(timeoutMs: number) {
  return Math.round(timeoutMs / 1000);
}

export function createAgentStreamTimeoutGuard(
  abortController: AbortController,
  options?: {
    firstOutputTimeoutMs?: number;
    idleTimeoutMs?: number;
    totalTimeoutMs?: number;
  },
) {
  const firstOutputTimeoutMs =
    options?.firstOutputTimeoutMs ?? AGENT_FIRST_OUTPUT_TIMEOUT_MS;
  const idleTimeoutMs = options?.idleTimeoutMs ?? AGENT_IDLE_TIMEOUT_MS;
  const totalTimeoutMs = options?.totalTimeoutMs ?? AGENT_TOTAL_TIMEOUT_MS;

  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const clearIdle = () => {
    if (idleTimer) {
      clearTimeout(idleTimer);
    }
    idleTimer = null;
  };

  const firstOutputTimer = setTimeout(() => {
    abortSafely(abortController, "first_output_timeout");
  }, firstOutputTimeoutMs);

  const totalTimer = setTimeout(() => {
    abortSafely(abortController, "total_timeout");
  }, totalTimeoutMs);

  const armIdle = () => {
    clearIdle();
    idleTimer = setTimeout(() => {
      abortSafely(abortController, "idle_timeout");
    }, idleTimeoutMs);
  };

  armIdle();

  return {
    markActivity() {
      clearTimeout(firstOutputTimer);
      armIdle();
    },
    markVisibleOutput() {
      clearTimeout(firstOutputTimer);
      armIdle();
    },
    cleanup() {
      clearTimeout(firstOutputTimer);
      clearTimeout(totalTimer);
      clearIdle();
    },
  };
}
