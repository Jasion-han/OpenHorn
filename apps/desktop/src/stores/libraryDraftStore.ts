import { create } from "zustand";
import { getDesktopBackendBase } from "../lib/backendBase";
import { useAuthStore } from "./authStore";

interface LibraryDraftState {
  identity: string;
  upload: { scope: string; files: File[]; folderId?: string | null } | null;
  runningUpload: File[] | null;
  question: {
    scope: string;
    text: string;
    model: string;
    requestId: string;
    signature: string;
  } | null;
  sourceQuestion: LibraryDraftState["question"];
  bind(identity: string): void;
  setUpload(value: LibraryDraftState["upload"]): void;
  beginUpload(files: File[]): boolean;
  endUpload(files: File[]): void;
  setQuestion(value: LibraryDraftState["question"], selectedSource?: boolean): void;
}
/** Memory-only drafts survive view navigation, never an identity change or app restart. */
export const useLibraryDraftStore = create<LibraryDraftState>((set, get) => ({
  identity: "",
  upload: null,
  runningUpload: null,
  question: null,
  sourceQuestion: null,
  bind: (identity) =>
    set((state) =>
      state.identity === identity
        ? {}
        : { identity, upload: null, runningUpload: null, question: null, sourceQuestion: null },
    ),
  setUpload: (upload) => set({ upload }),
  beginUpload: (files) => {
    if (get().runningUpload || get().upload?.files !== files) return false;
    set({ runningUpload: files });
    return true;
  },
  endUpload: (files) => {
    if (get().runningUpload === files) set({ runningUpload: null });
  },
  setQuestion: (value, selectedSource) =>
    set(selectedSource ? { sourceQuestion: value } : { question: value }),
}));

useAuthStore.subscribe((state, previous) => {
  if (state.user?.id !== previous.user?.id)
    useLibraryDraftStore.getState().bind(`${getDesktopBackendBase()}:${state.user?.id ?? ""}`);
});
