import { create } from "zustand";
import { createServerApi } from "../lib/serverApi";
import type { ApiUser, LoginInput, RegisterInput, User } from "../types/auth";

const api = createServerApi();

function mapUser(user: ApiUser): User {
  return {
    id: user.id,
    email: user.email,
    username: user.username,
  };
}

function toErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "请求失败";
}

interface AuthState {
  user: User | null;
  ready: boolean;
  loading: boolean;
  error: string | null;
  setUser: (user: User | null) => void;
  bootstrap: () => Promise<void>;
  login: (input: LoginInput) => Promise<void>;
  register: (input: RegisterInput) => Promise<void>;
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
      const { user } = await api.auth.me();
      set({
        user: user ? mapUser(user) : null,
        ready: true,
        loading: false,
      });
    } catch (error) {
      set({
        user: null,
        ready: true,
        loading: false,
        error: toErrorMessage(error),
      });
    }
  },

  async login(input) {
    set({ loading: true, error: null });
    try {
      const { user } = await api.auth.login(input);
      set({
        user: mapUser(user),
        ready: true,
        loading: false,
      });
    } catch (error) {
      set({
        loading: false,
        error: toErrorMessage(error),
      });
      throw error;
    }
  },

  async register(input) {
    set({ loading: true, error: null });
    try {
      const { user } = await api.auth.register(input);
      set({
        user: mapUser(user),
        ready: true,
        loading: false,
      });
    } catch (error) {
      set({
        loading: false,
        error: toErrorMessage(error),
      });
      throw error;
    }
  },

  async logout(options) {
    set({ loading: true, error: null });
    try {
      if (!options?.skipRequest) {
        await api.auth.logout();
      }
    } finally {
      set({
        user: null,
        ready: true,
        loading: false,
      });
    }
  },

  clearError: () => set({ error: null }),

  reset: () => set({ ...INITIAL_STATE }),
}));
