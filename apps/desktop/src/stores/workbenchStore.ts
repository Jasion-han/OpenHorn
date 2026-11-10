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
  navigationRevision: number;
  navigationTarget: { tab: "recipes" | "artifacts" | "reviews"; id: string; token: string } | null;
  openItem(tab: "recipes" | "artifacts" | "reviews", id: string): void;
  clearNavigation(token: string): void;
  tab: "recipes" | "artifacts" | "reviews";
  recipeDraft: string | null;
  artifactMessageId: string | null;
  artifactConversationId: string | null;
  artifactRefresh: number;
  recipeScheduleDraft: RecipeScheduleHandoff | null;
  openRecipeSchedule(draft: RecipeScheduleDraft): void;
  clearRecipeSchedule(handoffId: string): void;
  setTab(tab: WorkbenchState["tab"]): void;
  setRecipeDraft(text: string | null): void;
  setArtifactMessageId(id: string | null, conversationId?: string): void;
  refreshArtifacts(): void;
}
export function createWorkbenchStore(deps: { openScheduledTasks?: () => void } = {}) {
  return create<WorkbenchState>((set) => ({
    navigationRevision: 0,
    navigationTarget: null,
    openItem: (tab, id) =>
      set((state) => ({
        tab,
        navigationRevision: state.navigationRevision + 1,
        navigationTarget: { tab, id, token: crypto.randomUUID() },
      })),
    clearNavigation: (token) =>
      set((state) => (state.navigationTarget?.token === token ? { navigationTarget: null } : {})),
    tab: "recipes",
    recipeDraft: null,
    artifactMessageId: null,
    artifactConversationId: null,
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
    setArtifactMessageId: (artifactMessageId, conversationId) =>
      set({
        artifactMessageId,
        artifactConversationId: artifactMessageId ? (conversationId ?? null) : null,
      }),
    refreshArtifacts: () => set((state) => ({ artifactRefresh: state.artifactRefresh + 1 })),
  }));
}
export const useWorkbenchStore = createWorkbenchStore();
