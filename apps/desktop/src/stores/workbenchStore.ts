import type { RecipeValues } from "shared/types";
import { create } from "zustand";
import { useDesktopShellStore } from "./desktopShellStore";

export interface RecipeScheduleDraft {
  recipeId: string;
  version: number;
  title: string;
  prompt: string;
  values: RecipeValues;
  parameters?: Array<{ label: string; value: string }>;
}
export interface RecipeScheduleHandoff extends RecipeScheduleDraft {
  handoffId: string;
}

interface WorkbenchState {
  tab: "recipes" | "artifacts" | "reviews";
  recipeDraft: string | null;
  artifactMessageId: string | null;
  artifactRefresh: number;
  recipeScheduleDraft: RecipeScheduleHandoff | null;
  openRecipeSchedule(draft: RecipeScheduleDraft): void;
  clearRecipeSchedule(handoffId: string): void;
  setTab(tab: WorkbenchState["tab"]): void;
  setRecipeDraft(text: string | null): void;
  setArtifactMessageId(id: string | null): void;
  refreshArtifacts(): void;
}
export function createWorkbenchStore(deps: { openScheduledTasks?: () => void } = {}) {
  return create<WorkbenchState>((set) => ({
    tab: "recipes",
    recipeDraft: null,
    artifactMessageId: null,
    artifactRefresh: 0,
    recipeScheduleDraft: null,
    openRecipeSchedule: (draft) => {
      set({ recipeScheduleDraft: { ...structuredClone(draft), handoffId: crypto.randomUUID() } });
      (
        deps.openScheduledTasks ??
        (() => useDesktopShellStore.getState().openScheduledTasks("tasks"))
      )();
    },
    clearRecipeSchedule: (handoffId) =>
      set((state) =>
        state.recipeScheduleDraft?.handoffId === handoffId ? { recipeScheduleDraft: null } : {},
      ),
    setTab: (tab) => set({ tab }),
    setRecipeDraft: (recipeDraft) => set({ recipeDraft, tab: "recipes" }),
    setArtifactMessageId: (artifactMessageId) => set({ artifactMessageId }),
    refreshArtifacts: () => set((state) => ({ artifactRefresh: state.artifactRefresh + 1 })),
  }));
}
export const useWorkbenchStore = createWorkbenchStore();
