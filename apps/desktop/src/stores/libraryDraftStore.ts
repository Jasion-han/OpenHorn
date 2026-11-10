import { create } from "zustand";
import { getDesktopBackendBase } from "../lib/backendBase";
import { useAuthStore } from "./authStore";

interface LibraryDraftState {
  identity: string;
  upload: { scope: string; file: File } | null;
  question: {
    scope: string;
    text: string;
    model: string;
    requestId: string;
    signature: string;
  } | null;
  bind(identity: string): void;
  setUpload(value: LibraryDraftState["upload"]): void;
  setQuestion(value: LibraryDraftState["question"]): void;
}
/** Memory-only drafts survive view navigation, never an identity change or app restart. */
export const useLibraryDraftStore = create<LibraryDraftState>((set) => ({
  identity: "",
  upload: null,
  question: null,
  bind: (identity) =>
    set((state) => (state.identity === identity ? {} : { identity, upload: null, question: null })),
  setUpload: (upload) => set({ upload }),
  setQuestion: (question) => set({ question }),
}));

useAuthStore.subscribe((state, previous) => {
  if (state.user?.id !== previous.user?.id)
    useLibraryDraftStore.getState().bind(`${getDesktopBackendBase()}:${state.user?.id ?? ""}`);
});
