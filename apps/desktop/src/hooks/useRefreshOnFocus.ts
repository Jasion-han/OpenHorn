import { useEffect } from "react";
import { useAuthStore } from "../stores/authStore";
import { useChatStore } from "../stores/chatStore";
import { useProjectStore } from "../stores/projectStore";

const MIN_REFRESH_INTERVAL_MS = 3000;

let lastRefreshAt: number | null = null;

export interface ShouldRefreshOnFocusInput {
  now: number;
  lastRefreshAt: number | null;
  isStreaming: boolean;
  authReady: boolean;
  minIntervalMs: number;
}

/**
 * Pure gate for the focus-triggered refresh.
 *
 * - No session yet: nothing to load.
 * - Streaming: a reload flips `isLoading`, which disables the composer's send
 *   button and could race the in-flight turn.
 * - Throttle: alt-tabbing back and forth must not hammer the server.
 */
export function shouldRefreshOnFocus(input: ShouldRefreshOnFocusInput): boolean {
  if (!input.authReady) return false;
  if (input.isStreaming) return false;
  if (input.lastRefreshAt !== null && input.now - input.lastRefreshAt < input.minIntervalMs) {
    return false;
  }
  return true;
}

function refreshIfAllowed() {
  const auth = useAuthStore.getState();
  const chat = useChatStore.getState();
  const allowed = shouldRefreshOnFocus({
    now: Date.now(),
    lastRefreshAt,
    isStreaming: chat.isStreaming,
    authReady: auth.ready && auth.user !== null,
    minIntervalMs: MIN_REFRESH_INTERVAL_MS,
  });
  if (!allowed) return;

  lastRefreshAt = Date.now();
  // `loadConversations()` re-resolves `currentConversation` against the fresh
  // list, so a conversation deleted elsewhere (API / another client) drops the
  // user back to the welcome screen. That is the intended behavior.
  // Errors are swallowed here: both stores already record them in their state.
  void chat.loadConversations().catch(() => {});
  void useProjectStore
    .getState()
    .loadProjects()
    .catch(() => {});
}

/**
 * Re-fetches conversations and projects when the window regains focus or the
 * document becomes visible again, so changes made by other clients (web UI,
 * server API) show up without restarting the app.
 */
export function useRefreshOnFocus(): void {
  useEffect(() => {
    const handleFocus = () => {
      refreshIfAllowed();
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        refreshIfAllowed();
      }
    };

    window.addEventListener("focus", handleFocus);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.removeEventListener("focus", handleFocus);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, []);
}
