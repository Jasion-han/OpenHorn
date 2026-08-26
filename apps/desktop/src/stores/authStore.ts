import { create } from "zustand";
import { getDesktopBackendBase } from "../lib/backendBase";
import type { User } from "../types/auth";

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

  async bootstrap() {
    set({ loading: true, error: null });
    try {
      const base = getDesktopBackendBase();
      const res = await fetch(`${base}/auth/me`);
      const data = (await res.json()) as { user: User | null };
      set({ user: data.user, ready: true, loading: false });
    } catch {
      set({ user: null, ready: true, loading: false });
    }
  },

  async logout() {
    set({ user: null, ready: true, loading: false });
  },

  clearError: () => set({ error: null }),
  reset: () => set({ ...INITIAL_STATE }),
}));
