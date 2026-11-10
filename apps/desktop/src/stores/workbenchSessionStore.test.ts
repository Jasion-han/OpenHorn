import { expect, test } from "bun:test";
import type { RecipeSpec } from "shared/types";
import { createWorkbenchSessionStore, recipeInputValues } from "./workbenchSessionStore";

test("recipe input copies remain scoped to their version and login session", () => {
  const store = createWorkbenchSessionStore("backend-a:user");
  const values = { topic: "Draft" };
  store.getState().saveRecipeInputs("recipe", 2, values);
  values.topic = "Mutated";
  store.getState().saveRecipeInputs("other-recipe", 2, { topic: "Other" });
  expect(store.getState().recipeInputs.recipe.values.topic).toBe("Draft");
  expect(store.getState().recipeInputs["other-recipe"].values.topic).toBe("Other");
  store.getState().selectRecipe("recipe");
  store.getState().setOwner("backend-a:user");
  expect(store.getState().selectedRecipeId).toBe("recipe");
  store.getState().setOwner("backend-b:user");
  expect(store.getState().recipeInputs).toEqual({});
  expect(store.getState().selectedRecipeId).toBe(null);
});

test("continuations bind only the created conversation and are cleared on logout", () => {
  const store = createWorkbenchSessionStore("backend:user");
  store.getState().rememberContinuation("continuation", "artifact", 3);
  expect(store.getState().continuations.continuation).toEqual({
    artifactId: "artifact",
    sourceVersion: 3,
  });
  expect(store.getState().continuations.other).toBe(undefined);
  store.getState().setOwner(null);
  expect(store.getState().continuations).toEqual({});
  store.getState().rememberContinuation("old", "artifact", 3);
  expect(store.getState().continuations).toEqual({});
});

test("new recipe versions use current defaults and never resurrect removed parameter keys", () => {
  const spec: RecipeSpec = {
    title: "T",
    description: "",
    promptTemplate: "{{topic}}",
    outputFormat: "markdown",
    parameters: [
      { key: "topic", label: "Topic", type: "text", required: true, defaultValue: "New default" },
    ],
    requirements: { skills: [], mcpServers: [], workspace: false, webSearch: false },
  };
  const old = { version: 2, values: { topic: "Filled", removed: "Old" } };
  expect(recipeInputValues(spec, 2, old)).toEqual({ topic: "Filled" });
  expect(recipeInputValues(spec, 3, old)).toEqual({ topic: "New default" });
  expect(recipeInputValues(spec, 3)).toEqual({ topic: "New default" });
});
