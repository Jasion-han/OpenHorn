import { create } from "zustand";
import { authClient } from "../lib/authClient";
import type { LoginInput, RegisterInput, User } from "../types/auth";

function toErrorMessage(error: unknown) {
  if (error && typeof error === "object" && "message" in error) {
    return (error as { message: string }).message;
  }
  return error instanceof Error ? error.message : "Request failed";
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
      const { data: session } = await authClient.getSession();
      set({
        user: session?.user
          ? { id: session.user.id, email: session.user.email, username: session.user.name }
          : null,
        ready: true,
        loading: false,
      });
    } catch (error) {
      set({ user: null, ready: true, loading: false, error: toErrorMessage(error) });
    }
  },

  async login(input) {
    set({ loading: true, error: null });
    try {
      const { data, error } = await authClient.signIn.email({
        email: input.email,
        password: input.password,
        rememberMe: input.rememberMe ?? true,
      });
      if (error) throw error;
      set({
        user: data?.user
          ? { id: data.user.id, email: data.user.email, username: data.user.name }
          : null,
        ready: true,
        loading: false,
      });
    } catch (error) {
      set({ loading: false, error: toErrorMessage(error) });
      throw error;
    }
  },

  async register(input) {
    set({ loading: true, error: null });
    try {
      const { data, error } = await authClient.signUp.email({
        name: input.username,
        email: input.email,
        password: input.password,
      });
      if (error) throw error;
      set({
        user: data?.user
          ? { id: data.user.id, email: data.user.email, username: data.user.name }
          : null,
        ready: true,
        loading: false,
      });
    } catch (error) {
      set({ loading: false, error: toErrorMessage(error) });
      throw error;
    }
  },

  async logout(options) {
    set({ loading: true, error: null });
    try {
      if (!options?.skipRequest) {
        await authClient.signOut();
      }
    } finally {
      set({ user: null, ready: true, loading: false });
    }
  },

  clearError: () => set({ error: null }),
  reset: () => set({ ...INITIAL_STATE }),
}));
