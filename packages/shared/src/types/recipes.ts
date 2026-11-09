export interface RecipeParameter {
  key: string;
  label: string;
  type: "text" | "multiline" | "number";
  required: boolean;
  defaultValue?: string;
}
export interface RecipeRequirements {
  skills: string[];
  mcpServers: string[];
  workspace: boolean;
  webSearch: boolean;
}
export interface RecipeSpec {
  title: string;
  description: string;
  promptTemplate: string;
  parameters: RecipeParameter[];
  requirements: RecipeRequirements;
  projectId?: string;
  channelId?: string;
  modelId?: string;
  outputFormat: "markdown" | "html" | "openui";
}
export type RecipeValues = Record<string, string | number>;
/** HTTP dates are ISO strings, not Date instances. */
export interface TaskRecipe {
  id: string;
  version: number;
  spec: RecipeSpec;
  createdAt: string;
  updatedAt: string;
}
export interface RecipeVersion {
  recipeId: string;
  version: number;
  spec: RecipeSpec;
  createdAt: string;
}
export interface RecipeDetail {
  recipe: TaskRecipe;
  versions: RecipeVersion[];
}
export interface FrozenRecipeSnapshot {
  recipeId: string;
  version: number;
  spec: RecipeSpec;
  values: RecipeValues;
  renderedPrompt: string;
}
export interface PreparedRecipe {
  conversationId: string;
  prompt: string;
  requirements: RecipeRequirements;
  recipeId: string;
  recipeVersion: number;
}

/** Optional task-level preferences; these do not change the recipe revision. */
export interface RecipeScheduleOptions {
  title?: string;
  notifyOnComplete?: boolean;
  /** Stable for a single confirmation and all of its network retries. */
  requestId?: string;
}
