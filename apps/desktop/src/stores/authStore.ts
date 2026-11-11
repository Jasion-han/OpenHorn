import { create } from "zustand";
import { getDesktopBackendBase } from "../lib/backendBase";
import type { User } from "../types/auth";
import { useBackendStatusStore } from "./backendStatusStore";

interface AuthState {
  user: User | null;
  ready: boolean;
  loading: boolean;
  error: string | null;
  setUser: (user: User | null) => void;
  bootstrap: () => Promise<void>;
  logout: (options?: { skipRequest?: boolean }) => Promise<void>;
  clearError: () => void;
  reset: () => void;
}

const INITIAL_STATE = {
  user: null as User | null,
  ready: false,
  loading: false,
  error: null as string | null,
};

export const useAuthStore = create<AuthState>((set) => ({
  ...INITIAL_STATE,

  setUser: (user) => set({ user }),

  // Part of the full server load (lib/serverState). A network failure is
  // reported to the connection store and leaves `user` as it was: null means
  // "not loaded yet", never "the server said nobody" — the UI shows the
  // connection state instead of a fake "User".
  async bootstrap() {
    set({ loading: true, error: null });
    const base = getDesktopBackendBase();
    let res: Response;
    try {
      res = await fetch(`${base}/auth/me`, { credentials: "include" });
    } catch (error) {
      useBackendStatusStore
        .getState()
        .markDown(error instanceof Error ? error.message : "Failed to fetch");
      set({
        ready: true,
        loading: false,
        error: error instanceof Error ? error.message : "Failed to fetch",
      });
      throw error;
    }
    useBackendStatusStore.getState().markUp();
    try {
      if (!res.ok) throw new Error(`Request failed (${res.status})`);
      const data = (await res.json()) as { user: User | null };
      set({ user: data.user, ready: true, loading: false });
    } catch (error) {
      set({
        ready: true,
        loading: false,
        error: error instanceof Error ? error.message : "Request failed",
      });
      throw error;
    }
  },

  async logout() {
    set({ user: null, ready: true, loading: false });
  },

  clearError: () => set({ error: null }),
  reset: () => set({ ...INITIAL_STATE }),
}));
