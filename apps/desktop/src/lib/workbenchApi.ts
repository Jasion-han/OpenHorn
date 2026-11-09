import type {
  AppendArtifactVersionInput,
  ArtifactDetail,
  ArtifactMutationResult,
  CreateArtifactInput,
  RecipeRequirements,
  RecipeScheduleOptions,
  RecipeSpec,
  RecipeValues,
  RecipeVersion,
  SavedArtifact,
  ScheduledTask,
  ScheduledTaskFrequency,
  TaskRecipe,
  UpdateArtifactInput,
} from "shared/types";
import { getDesktopBackendBase } from "./backendBase";
import { getWorkbenchLabel } from "./i18n/agent";
import { fetchWithBackendStatus } from "./serverApi";

export class WorkbenchApiError extends Error {
  constructor(
    readonly errorCode: string,
    readonly status: number,
  ) {
    super(errorCode);
  }
}
async function request<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const response = await fetchWithBackendStatus(`${getDesktopBackendBase()}${path}`, {
    method,
    credentials: "include",
    ...(body === undefined
      ? {}
      : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });
  const data = (await response.json().catch(() => ({}))) as { errorCode?: string };
  if (!response.ok) throw new WorkbenchApiError(data.errorCode ?? "unknown", response.status);
  return data as T;
}
export function workbenchError(error: unknown): string {
  const keys = {
    recipe_not_found: "workbench.errors.notFound",
    artifact_not_found: "workbench.errors.notFound",
    invalid_recipe: "workbench.errors.invalidRecipe",
    invalid_artifact: "workbench.errors.invalidArtifact",
    invalid_parameters: "workbench.errors.invalidParameters",
    recipe_version_conflict: "workbench.errors.versionConflict",
    artifact_version_conflict: "workbench.errors.versionConflict",
    project_not_found: "workbench.errors.projectMissing",
    channel_not_found: "workbench.errors.channelMissing",
    source_not_found: "workbench.errors.sourceMissing",
    source_not_ready: "workbench.errors.sourceNotReady",
    unsupported_schedule_format: "workbench.errors.scheduleFormat",
  } as const;
  const code = error instanceof WorkbenchApiError ? error.errorCode : "unknown";
  return getWorkbenchLabel(keys[code as keyof typeof keys] ?? "workbench.errors.unknown");
}
export const workbenchApi = {
  recipes: {
    list: () => request<{ recipes: TaskRecipe[] }>("/recipes"),
    detail: (id: string) =>
      request<{ recipe: TaskRecipe; versions: RecipeVersion[] }>(
        `/recipes/${encodeURIComponent(id)}`,
      ),
    create: (spec: RecipeSpec) => request<{ recipe: TaskRecipe }>("/recipes", "POST", { spec }),
    update: (id: string, spec: RecipeSpec, expectedVersion: number) =>
      request<{ recipe: TaskRecipe }>(`/recipes/${encodeURIComponent(id)}`, "PUT", {
        spec,
        expectedVersion,
      }),
    delete: (id: string) =>
      request<{ success: boolean }>(`/recipes/${encodeURIComponent(id)}`, "DELETE"),
    prepare: (id: string, version: number, values: RecipeValues) =>
      request<{
        conversationId: string;
        prompt: string;
        requirements: RecipeRequirements;
        recipeId: string;
        recipeVersion: number;
      }>(`/recipes/${encodeURIComponent(id)}/prepare`, "POST", { version, values }),
    schedule: (
      id: string,
      data: {
        version: number;
        values: RecipeValues;
        frequency: ScheduledTaskFrequency;
        time: string;
      } & RecipeScheduleOptions,
    ) =>
      request<{ task: ScheduledTask }>(`/recipes/${encodeURIComponent(id)}/schedule`, "POST", data),
  },
  artifacts: {
    list: () => request<{ artifacts: SavedArtifact[] }>("/artifacts"),
    detail: (id: string, version?: number) =>
      request<ArtifactDetail>(
        `/artifacts/${encodeURIComponent(id)}${version === undefined ? "" : `?version=${version}`}`,
      ),
    create: (input: CreateArtifactInput) =>
      request<ArtifactMutationResult>("/artifacts", "POST", input),
    append: (id: string, input: AppendArtifactVersionInput) =>
      request<ArtifactMutationResult>(
        `/artifacts/${encodeURIComponent(id)}/versions`,
        "POST",
        input,
      ),
    update: (id: string, input: UpdateArtifactInput) =>
      request<{ artifact: SavedArtifact }>(`/artifacts/${encodeURIComponent(id)}`, "PATCH", input),
    delete: (id: string) =>
      request<{ success: boolean }>(`/artifacts/${encodeURIComponent(id)}`, "DELETE"),
  },
};
