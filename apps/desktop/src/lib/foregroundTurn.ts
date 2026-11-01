/**
 * The foreground composer's caller-side turn outlives its page. Navigating to
 * settings must neither lose Stop during preparation nor let a second page
 * claim a still-running Chat stream. Agent execution hands off to its shared
 * run lifecycle after acceptance; stopped persistence can finish independently.
 */
export interface ActiveTurn {
  stopped: boolean;
  abort?: () => void | Promise<void>;
  stopping?: void | Promise<void>;
}

export const activeTurnRef: { current: ActiveTurn | null } = { current: null };

export function beginTurn(): ActiveTurn {
  const turn: ActiveTurn = { stopped: false };
  activeTurnRef.current = turn;
  return turn;
}

export function endTurn(turn: ActiveTurn): void {
  if (activeTurnRef.current === turn) activeTurnRef.current = null;
}
