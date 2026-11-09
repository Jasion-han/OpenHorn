import type { RecipeSpec } from "shared/types";
import { getWorkbenchLabel as label } from "./i18n/agent";
export function recipePresets(): RecipeSpec[] {
  const base = { skills: [], mcpServers: [], workspace: false, webSearch: false };
  return [
    {
      title: label("workbench.recipes.researchTitle"),
      description: label("workbench.recipes.researchDescription"),
      promptTemplate: label("workbench.recipes.researchPrompt"),
      outputFormat: "markdown",
      requirements: { ...base, webSearch: true },
      parameters: [
        {
          key: "companies",
          label: label("workbench.recipes.researchCompanies"),
          type: "text",
          required: true,
        },
        {
          key: "period",
          label: label("workbench.recipes.researchPeriod"),
          type: "text",
          required: true,
          defaultValue: label("workbench.recipes.researchPeriodDefault"),
        },
        {
          key: "focus",
          label: label("workbench.recipes.researchFocus"),
          type: "multiline",
          required: true,
          defaultValue: label("workbench.recipes.researchFocusDefault"),
        },
      ],
    },
    {
      title: label("workbench.recipes.csvTitle"),
      description: label("workbench.recipes.csvDescription"),
      promptTemplate: label("workbench.recipes.csvPrompt"),
      outputFormat: "markdown",
      requirements: { ...base, workspace: true },
      parameters: [
        { key: "file", label: label("workbench.recipes.csvFile"), type: "text", required: true },
        {
          key: "goal",
          label: label("workbench.recipes.csvGoal"),
          type: "multiline",
          required: true,
          defaultValue: label("workbench.recipes.csvGoalDefault"),
        },
      ],
    },
    {
      title: label("workbench.recipes.reviewTitle"),
      description: label("workbench.recipes.reviewDescription"),
      promptTemplate: label("workbench.recipes.reviewPrompt"),
      outputFormat: "markdown",
      requirements: { ...base, workspace: true },
      parameters: [
        {
          key: "path",
          label: label("workbench.recipes.reviewPath"),
          type: "text",
          required: true,
          defaultValue: ".",
        },
        {
          key: "focus",
          label: label("workbench.recipes.reviewFocus"),
          type: "multiline",
          required: true,
          defaultValue: label("workbench.recipes.reviewDefault"),
        },
      ],
    },
  ];
}
export function emptyRecipe(promptTemplate = ""): RecipeSpec {
  return {
    title: "",
    description: "",
    promptTemplate,
    parameters: [],
    outputFormat: "markdown",
    requirements: { skills: [], mcpServers: [], workspace: false, webSearch: false },
  };
}
