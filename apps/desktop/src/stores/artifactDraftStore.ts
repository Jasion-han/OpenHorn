import type { ArtifactVersion } from "shared/types";
import { create } from "zustand";
import { useAuthStore } from "./authStore";

export interface ArtifactEditDraft {
  content: string;
  format: ArtifactVersion["format"];
  sourceVersion: number;
  expectedVersion: number;
  originalContent: string;
  originalFormat: ArtifactVersion["format"];
}

interface ArtifactDraftState {
  ownerId: string | null;
  selectedId: string | null;
  drafts: Record<string, ArtifactEditDraft>;
  setOwner(ownerId: string | null): void;
  select(id: string | null): void;
  put(id: string, draft: ArtifactEditDraft): void;
  discard(id: string): void;
}

/** Temporary editing only: never written to disk or shared between login sessions. */
export function createArtifactDraftStore(ownerId: string | null = null) {
  return create<ArtifactDraftState>((set) => ({
    ownerId,
    selectedId: null,
    drafts: {},
    setOwner: (ownerId) =>
      set((state) => (state.ownerId === ownerId ? {} : { ownerId, selectedId: null, drafts: {} })),
    select: (selectedId) => set({ selectedId }),
    put: (id, draft) =>
      set((state) => (state.ownerId ? { drafts: { ...state.drafts, [id]: { ...draft } } } : {})),
    discard: (id) =>
      set((state) => {
        const drafts = { ...state.drafts };
        delete drafts[id];
        return { drafts };
      }),
  }));
}

export const useArtifactDraftStore = createArtifactDraftStore(
  useAuthStore.getState().user?.id ?? null,
);
useAuthStore.subscribe((state) => {
  useArtifactDraftStore.getState().setOwner(state.user?.id ?? null);
});
