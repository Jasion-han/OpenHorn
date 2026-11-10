import { create } from "zustand";
import { useAuthStore } from "./authStore";

interface LibraryState {
  target: { id: string; token: string } | null;
  navigationRevision: number;
  openDocument(id: string): void;
  clearTarget(token: string): void;
}
export const useLibraryStore = create<LibraryState>((set) => ({
  target: null,
  navigationRevision: 0,
  openDocument: (id) =>
    set((state) => ({
      target: { id, token: crypto.randomUUID() },
      navigationRevision: state.navigationRevision + 1,
    })),
  clearTarget: (token) => set((state) => (state.target?.token === token ? { target: null } : {})),
}));

useAuthStore.subscribe((state, previous) => {
  if (state.user?.id !== previous.user?.id)
    useLibraryStore.setState((s) => ({
      target: null,
      navigationRevision: s.navigationRevision + 1,
    }));
});
