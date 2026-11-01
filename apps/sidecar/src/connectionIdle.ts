/** A live run or approval wait owns its socket even without client input. */
export function shouldReapIdleConnection(
  state: {
    lastActivityAt: number;
    agentRuns: { size: number };
    pendingApprovals: { size: number };
  },
  now: number,
  timeoutMs: number,
): boolean {
  return (
    state.agentRuns.size === 0 &&
    state.pendingApprovals.size === 0 &&
    now - state.lastActivityAt > timeoutMs
  );
}
