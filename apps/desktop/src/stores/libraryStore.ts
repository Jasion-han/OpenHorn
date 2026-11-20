import type { LibraryListOptions } from "shared/types";
import { create } from "zustand";
import { useAuthStore } from "./authStore";

export interface LibraryBrowsePosition {
  identity: string;
  scopeKey: string;
  filters: LibraryListOptions;
  query: string;
  searched: boolean;
  documentId: string;
  match?: { index: number; revision: number };
}

interface LibraryState {
  browsePosition: LibraryBrowsePosition | null;
  saveBrowsePosition(position: LibraryBrowsePosition): void;
  target: { id: string; token: string } | null;
  navigationRevision: number;
  openDocument(id: string): void;
  clearTarget(token: string): void;
}
export const useLibraryStore = create<LibraryState>((set) => ({
  browsePosition: null,
  saveBrowsePosition: (browsePosition) => set({ browsePosition }),
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
      browsePosition: null,
      navigationRevision: s.navigationRevision + 1,
    }));
});
