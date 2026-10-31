import { create } from "zustand";
import { MAX_PROMPT_LENGTH } from "../lib/genui/sandbox";

/**
 * Generative UI preferences and the one channel from an answer back to the
 * composer.
 *
 * `enabled` decides whether the generative-UI rules are appended to the system
 * prompt (they cost several thousand tokens, so they are opt-in). It is a
 * per-machine preference in localStorage, like the external editor choice.
 * Blocks the model writes are rendered whether or not it is on.
 *
 * `composerRequest` carries text an answer asked to send (@ToAssistant in a
 * component, `openhorn.sendPrompt` in a sandbox). It is only ever placed in the
 * composer for the user to review — never sent on its own.
 */

export const GEN_UI_STORAGE_KEY = "openhorn.genUi.enabled";

export interface GenUiStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

function defaultStorage(): GenUiStorage | null {
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage;
  } catch {
    return null;
  }
}

export interface ComposerRequest {
  text: string;
  /** Changes on every request, so the same text twice still fires. */
  nonce: number;
}

export interface GenUiState {
  enabled: boolean;
  composerRequest: ComposerRequest | null;
  setEnabled: (enabled: boolean) => void;
  toggle: () => void;
  requestComposerText: (text: string) => void;
  clearComposerRequest: (nonce: number) => void;
}

export function createGenUiStore(storage: GenUiStorage | null = defaultStorage()) {
  let initial = false;
  try {
    initial = storage?.getItem(GEN_UI_STORAGE_KEY) === "true";
  } catch {
    initial = false;
  }
  let nonce = 0;
  return create<GenUiState>((set, get) => ({
    enabled: initial,
    composerRequest: null,
    setEnabled: (enabled) => {
      try {
        storage?.setItem(GEN_UI_STORAGE_KEY, String(enabled));
      } catch {
        // Full or blocked storage: the choice still applies for this session.
      }
      set({ enabled });
    },
    toggle: () => get().setEnabled(!get().enabled),
    requestComposerText: (text) => {
      // Capped here so every source (@ToAssistant, Button labels, the sandbox
      // bridge) gets the same limit.
      const trimmed = text.trim().slice(0, MAX_PROMPT_LENGTH);
      if (!trimmed) return;
      nonce += 1;
      set({ composerRequest: { text: trimmed, nonce } });
    },
    clearComposerRequest: (requestNonce) => {
      if (get().composerRequest?.nonce === requestNonce) set({ composerRequest: null });
    },
  }));
}

export const useGenUiStore = createGenUiStore();
