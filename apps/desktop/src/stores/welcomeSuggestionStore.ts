import { create } from "zustand";
import { getDesktopBackendBase } from "../lib/backendBase";
import { fetchWithBackendStatus } from "../lib/serverApi";
import { useAuthStore } from "./authStore";

export interface WelcomeSuggestionsResult {
  items: string[];
  /** The server scheduled a regeneration; a newer set will exist shortly. */
  stale: boolean;
}

/**
 * When a read reports a scheduled regeneration, check back a couple of times so
 * a set that finishes generating while the user is still looking at the welcome
 * screen actually appears — instead of waiting for the next visit.
 */
export const STALE_RECHECK_DELAYS_MS = [8_000, 20_000] as const;

export interface WelcomeSuggestionDeps {
  fetchSuggestions?: () => Promise<WelcomeSuggestionsResult>;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface WelcomeSuggestionState {
  /** Personalised suggestions from the server; empty means "show the built-in defaults". */
  items: string[];
  /**
   * Reads the cached set. Part of the unified server load (lib/serverState), so
   * a start while the server was down picks the real set up on reconnect; the
   * welcome screen also refreshes it on each visit.
   */
  load: () => Promise<void>;
  reset: () => void;
}

async function defaultFetchSuggestions(): Promise<WelcomeSuggestionsResult> {
  try {
    const response = await fetchWithBackendStatus(
      `${getDesktopBackendBase()}/settings/welcome-suggestions`,
    );
    if (!response.ok) return { items: [], stale: false };
    const data = (await response.json()) as { suggestions?: unknown; stale?: unknown };
    const items = Array.isArray(data.suggestions)
      ? data.suggestions.filter((item): item is string => typeof item === "string")
      : [];
    return { items, stale: data.stale === true };
  } catch {
    // Offline: the request reported it; the defaults stay on screen.
    return { items: [], stale: false };
  }
}

export function createWelcomeSuggestionStore(deps: WelcomeSuggestionDeps = {}) {
  const fetchSuggestions = deps.fetchSuggestions ?? defaultFetchSuggestions;
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer =
    deps.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const timers = new Set<unknown>();
  let generation = 0;
  let inflight: Promise<WelcomeSuggestionsResult> | null = null;
  // One recheck series at a time, however many loads report "stale".
  let recheckScheduled = false;

  return create<WelcomeSuggestionState>((set) => {
    const read = (): Promise<WelcomeSuggestionsResult> => {
      if (inflight) return inflight;
      const run = fetchSuggestions()
        .catch(() => ({ items: [], stale: false }))
        .finally(() => {
          if (inflight === run) inflight = null;
        });
      inflight = run;
      return run;
    };

    const apply = ({ items }: WelcomeSuggestionsResult) => {
      // A failed / empty read never wipes a set already shown.
      if (items.length > 0) set({ items });
    };

    return {
      items: [],
      reset: () => {
        generation++;
        for (const handle of timers) clearTimer(handle);
        timers.clear();
        inflight = null;
        recheckScheduled = false;
        set({ items: [] });
      },
      load: async () => {
        const owner = generation;
        const result = await read();
        if (owner !== generation) return;
        apply(result);
        if (!result.stale || recheckScheduled) return;
        recheckScheduled = true;
        STALE_RECHECK_DELAYS_MS.forEach((delay, index) => {
          const handle = setTimer(() => {
            timers.delete(handle);
            if (owner !== generation) return;
            void read().then((result) => {
              if (owner === generation) apply(result);
            });
            if (index === STALE_RECHECK_DELAYS_MS.length - 1) recheckScheduled = false;
          }, delay);
          timers.add(handle);
        });
      },
    };
  });
}

export const useWelcomeSuggestionStore = createWelcomeSuggestionStore();

useAuthStore.subscribe((state, previous) => {
  if (state.user?.id !== previous.user?.id) useWelcomeSuggestionStore.getState().reset();
});
