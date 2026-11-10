import { expect, test } from "bun:test";
import { createWorkbenchStore } from "./workbenchStore";

test("search navigation can only be consumed by its own token", () => {
  const store = createWorkbenchStore();
  store.getState().openItem("artifacts", "first");
  const old = store.getState().navigationTarget;
  store.getState().openItem("recipes", "second");
  if (!old) throw new Error("Missing target");
  store.getState().clearNavigation(old.token);
  expect(store.getState().tab).toBe("recipes");
  expect(store.getState().navigationTarget?.id).toBe("second");
  const current = store.getState().navigationTarget;
  if (!current) throw new Error("Missing target");
  store.getState().clearNavigation(current.token);
  expect(store.getState().navigationTarget).toBe(null);
});

test("recipe schedule handoff is a frozen memory-only draft until matching confirm or cancel", () => {
  let navigations = 0;
  const store = createWorkbenchStore({
    openScheduledTasks: () => {
      navigations++;
    },
  });
  const draft = {
    recipeId: "synthetic-recipe",
    version: 3,
    title: "Synthetic",
    prompt: "Frozen prompt",
    values: { company: "Original" },
    parameters: [{ label: "Company", value: "Original" }],
  };
  store.getState().openRecipeSchedule(draft);
  const first = store.getState().recipeScheduleDraft;
  expect(navigations).toBe(1);
  expect(first?.version).toBe(3);
  draft.values.company = "Changed after handoff";
  expect(store.getState().recipeScheduleDraft?.values.company).toBe("Original");
  // Reading/StrictMode mount cycles do not consume it or create any task.
  expect(store.getState().recipeScheduleDraft?.handoffId).toBe(first?.handoffId);
  store.getState().openRecipeSchedule({ ...draft, version: 4 });
  const second = store.getState().recipeScheduleDraft;
  expect(second?.handoffId === first?.handoffId).toBe(false);
  if (!first || !second) throw new Error("Missing handoff");
  store.getState().clearRecipeSchedule(first.handoffId);
  expect(store.getState().recipeScheduleDraft?.version).toBe(4);
  store.getState().clearRecipeSchedule(second.handoffId);
  expect(store.getState().recipeScheduleDraft).toBe(null);
});
