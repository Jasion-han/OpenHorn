import { create } from "zustand";
import type { DocumentInputOption } from "../lib/documentInput";
import { useAuthStore } from "./authStore";

const initialOwner = () => useAuthStore.getState().user?.id ?? null;
export const useDocumentInputStore = create<{
  owner: string | null;
  options: WeakMap<File, DocumentInputOption>;
  revision: number;
  set(file: File, value: DocumentInputOption): void;
}>((set) => ({
  owner: initialOwner(),
  options: new WeakMap(),
  revision: 0,
  set: (file, value) =>
    set((state) => {
      state.options.set(file, value);
      return { revision: state.revision + 1 };
    }),
}));
useAuthStore.subscribe((state) => {
  if ((state.user?.id ?? null) !== useDocumentInputStore.getState().owner)
    useDocumentInputStore.setState({
      owner: state.user?.id ?? null,
      options: new WeakMap(),
      revision: 0,
    });
});
