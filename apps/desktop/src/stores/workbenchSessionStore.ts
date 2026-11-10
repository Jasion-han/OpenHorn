import type { RecipeSpec, RecipeValues } from "shared/types";
import { create } from "zustand";
import { getDesktopBackendBase } from "../lib/backendBase";
import { useAuthStore } from "./authStore";
import { useWorkbenchStore } from "./workbenchStore";

export interface RecipeInputDraft {
  version: number;
  values: RecipeValues;
}
interface WorkbenchSessionState {
  owner: string | null;
  selectedRecipeId: string | null;
  recipeInputs: Record<string, RecipeInputDraft>;
  continuations: Record<string, { artifactId: string; sourceVersion: number }>;
  setOwner(owner: string | null): void;
  selectRecipe(id: string | null): void;
  saveRecipeInputs(id: string, version: number, values: RecipeValues): void;
  rememberContinuation(conversationId: string, artifactId: string, sourceVersion: number): void;
}

export function recipeInputValues(
  spec: RecipeSpec,
  version: number,
  saved?: RecipeInputDraft,
): RecipeValues {
  return Object.fromEntries(
    spec.parameters.map((parameter) => [
      parameter.key,
      saved?.version === version
        ? (saved.values[parameter.key] ?? parameter.defaultValue ?? "")
        : (parameter.defaultValue ?? ""),
    ]),
  );
}

/** Current login only; neither continuations nor unfinished parameters go to disk. */
export function createWorkbenchSessionStore(owner: string | null = null) {
  return create<WorkbenchSessionState>((set) => ({
    owner,
    selectedRecipeId: null,
    recipeInputs: {},
    continuations: {},
    setOwner: (owner) =>
      set((state) =>
        state.owner === owner
          ? {}
          : {
              owner,
              selectedRecipeId: null,
              recipeInputs: {},
              continuations: {},
            },
      ),
    selectRecipe: (selectedRecipeId) => set({ selectedRecipeId }),
    saveRecipeInputs: (id, version, values) =>
      set((state) =>
        state.owner
          ? {
              recipeInputs: { ...state.recipeInputs, [id]: { version, values: { ...values } } },
            }
          : {},
      ),
    rememberContinuation: (conversationId, artifactId, sourceVersion) =>
      set((state) => {
        if (!state.owner) return {};
        const entries = Object.entries(state.continuations).filter(([id]) => id !== conversationId);
        return {
          continuations: Object.fromEntries([
            ...entries.slice(-127),
            [conversationId, { artifactId, sourceVersion }],
          ]),
        };
      }),
  }));
}

function currentOwner() {
  const id = useAuthStore.getState().user?.id;
  return id ? `${getDesktopBackendBase()}:${id}` : null;
}
export const useWorkbenchSessionStore = createWorkbenchSessionStore(currentOwner());
useAuthStore.subscribe(() => {
  const owner = currentOwner();
  if (useWorkbenchSessionStore.getState().owner === owner) return;
  useWorkbenchSessionStore.getState().setOwner(owner);
  useWorkbenchStore.getState().setArtifactMessageId(null);
  const target = useWorkbenchStore.getState().navigationTarget;
  if (target) useWorkbenchStore.getState().clearNavigation(target.token);
});
