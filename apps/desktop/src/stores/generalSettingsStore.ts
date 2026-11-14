import { create } from "zustand";
import { createServerApi } from "../lib/serverApi";
import { useAuthStore } from "./authStore";

const SYSTEM_PROMPT_KEY = "chat.systemPrompt";
interface GeneralSettingsState {
  ownerId: string | null;
  value: string;
  savedValue: string;
  loaded: boolean;
  loading: boolean;
  saving: boolean;
  editing: boolean;
  error: "load" | "save" | null;
  setOwner(ownerId: string | null): void;
  setValue(value: string): void;
  edit(): void;
  cancel(): void;
  load(): Promise<void>;
  save(): Promise<boolean>;
}
const initial = {
  value: "",
  savedValue: "",
  loaded: false,
  loading: false,
  saving: false,
  editing: false,
  error: null,
} as const;

export function createGeneralSettingsStore(
  deps: {
    read(): Promise<string>;
    write(value: string): Promise<void>;
  },
  ownerId: string | null = null,
) {
  let epoch = 0;
  return create<GeneralSettingsState>((set, get) => ({
    ...initial,
    ownerId,
    setOwner: (ownerId) => {
      if (get().ownerId === ownerId) return;
      epoch++;
      set({ ...initial, ownerId });
    },
    setValue: (value) => {
      if (get().loaded && !get().saving)
        set({ value, error: get().error === "save" ? null : get().error });
    },
    edit: () => {
      if (get().loaded && !get().saving) set({ editing: true });
    },
    cancel: () => {
      if (!get().saving) set({ value: get().savedValue, editing: false, error: null });
    },
    async load() {
      if (!get().ownerId || get().saving) return;
      const request = ++epoch;
      set({ loading: true, error: null });
      try {
        const value = await deps.read();
        if (request !== epoch) return;
        const state = get();
        const dirty = state.value !== state.savedValue;
        set({
          savedValue: value,
          value: dirty ? state.value : value,
          editing: dirty ? state.editing : !value,
          loaded: true,
          loading: false,
        });
      } catch {
        if (request === epoch) set({ loading: false, error: "load" });
      }
    },
    async save() {
      const state = get();
      if (!state.ownerId || !state.loaded || state.saving) return false;
      if (state.value === state.savedValue) return true;
      const request = ++epoch;
      const value = state.value;
      set({ saving: true, loading: false, error: null });
      try {
        await deps.write(value);
        if (request !== epoch) return false;
        set({ value, savedValue: value, editing: false, saving: false });
        return true;
      } catch {
        if (request === epoch) set({ saving: false, error: "save" });
        return false;
      }
    },
  }));
}

const api = createServerApi();
export const useGeneralSettingsStore = createGeneralSettingsStore(
  {
    read: async () =>
      (await api.settings.get([SYSTEM_PROMPT_KEY])).settings[SYSTEM_PROMPT_KEY] ?? "",
    write: async (value) => {
      await api.settings.set(SYSTEM_PROMPT_KEY, value || null);
    },
  },
  useAuthStore.getState().user?.id ?? null,
);
useAuthStore.subscribe((state) =>
  useGeneralSettingsStore.getState().setOwner(state.user?.id ?? null),
);
