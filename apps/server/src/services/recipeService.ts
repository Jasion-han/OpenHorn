import { createHash } from "node:crypto";
import { channels, projects, taskRecipes, taskRecipeVersions } from "db";
import { and, desc, eq } from "drizzle-orm";
import { RecipeValidationError, renderRecipePrompt, validateRecipeSpec } from "shared/recipes";
import type {
  FrozenRecipeSnapshot,
  PreparedRecipe,
  RecipeDetail,
  RecipeScheduleOptions,
  RecipeSpec,
  RecipeVersion,
  ScheduledTaskFrequency,
  TaskRecipe,
} from "shared/types";
import { db } from "../db";
import { generateId } from "../utils";
import { getChannelById, getChannels, resolveModelIdFromChannelItem } from "./channelService";
import { createConversation } from "./conversationService";
import { createScheduledTask, getScheduledTask } from "./scheduledTaskService";

export class RecipeServiceError extends Error {
  constructor(
    readonly code:
      | "recipe_not_found"
      | "invalid_recipe"
      | "recipe_version_conflict"
      | "invalid_parameters"
      | "project_not_found"
      | "channel_not_found"
      | "unsupported_schedule_format",
    readonly status: 400 | 404 | 409,
    message: string,
  ) {
    super(message);
    this.name = "RecipeServiceError";
  }
}
function recipeItem(row: typeof taskRecipes.$inferSelect): TaskRecipe {
  return {
    id: row.id,
    version: row.version,
    spec: validateRecipeSpec(JSON.parse(row.spec)),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
function revisionItem(row: typeof taskRecipeVersions.$inferSelect): RecipeVersion {
  return {
    recipeId: row.recipeId,
    version: row.version,
    spec: validateRecipeSpec(JSON.parse(row.spec)),
    createdAt: row.createdAt.toISOString(),
  };
}
async function validateReferences(
  userId: string,
  spec: RecipeSpec,
): Promise<{ channelId?: string; modelId?: string }> {
  if (spec.requirements.workspace && !spec.projectId)
    throw new RecipeServiceError("project_not_found", 400, "A workspace recipe requires a project");
  if (spec.projectId) {
    const [project] = await db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.id, spec.projectId), eq(projects.userId, userId)))
      .limit(1);
    if (!project) throw new RecipeServiceError("project_not_found", 404, "Project not found");
  }
  if (!spec.channelId) return {};
  // Resolve the selected channel's strict default without credentials, probes or
  // breaker reservations. createConversation intentionally clears partial pairs.
  const [owned] = await db
    .select({ id: channels.id })
    .from(channels)
    .where(and(eq(channels.id, spec.channelId), eq(channels.userId, userId)))
    .limit(1);
  if (!owned) throw new RecipeServiceError("channel_not_found", 404, "Channel not found");
  const channel = await getChannelById(userId, spec.channelId);
  if (!channel || !channel.enabled)
    throw new RecipeServiceError("channel_not_found", 404, "Channel not found or disabled");
  const modelId = resolveModelIdFromChannelItem(channel, spec.modelId);
  if (!modelId)
    throw new RecipeServiceError(
      "channel_not_found",
      404,
      "Model not found or disabled on channel",
    );
  return { channelId: channel.id, modelId };
}
async function executionReferences(userId: string, spec: RecipeSpec) {
  const selected = await validateReferences(userId, spec);
  if (selected.channelId) {
    const channel = await getChannelById(userId, selected.channelId);
    if (!channel.hasApiKey)
      throw new RecipeServiceError("channel_not_found", 404, "Channel credentials are missing");
    return selected;
  }
  const channel = (await getChannels(userId)).find((item) => item.enabled && item.isDefault);
  const modelId = channel ? resolveModelIdFromChannelItem(channel) : null;
  if (!channel || !modelId || !channel.hasApiKey)
    throw new RecipeServiceError("channel_not_found", 404, "No enabled default channel and model");
  // Conversation normalization clears partial pairs; resolve defaults before handing off.
  return { channelId: channel.id, modelId };
}
async function ownedRecipe(userId: string, recipeId: string) {
  const [recipe] = await db
    .select()
    .from(taskRecipes)
    .where(and(eq(taskRecipes.id, recipeId), eq(taskRecipes.userId, userId)))
    .limit(1);
  return recipe ?? null;
}
function positiveVersion(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
async function ownedVersion(
  userId: string,
  recipeId: string,
  version: unknown,
): Promise<RecipeVersion> {
  if (!positiveVersion(version))
    throw new RecipeServiceError("invalid_parameters", 400, "A positive version is required");
  if (!(await ownedRecipe(userId, recipeId)))
    throw new RecipeServiceError("recipe_not_found", 404, "Recipe not found");
  const [row] = await db
    .select()
    .from(taskRecipeVersions)
    .where(and(eq(taskRecipeVersions.recipeId, recipeId), eq(taskRecipeVersions.version, version)))
    .limit(1);
  if (!row) throw new RecipeServiceError("recipe_not_found", 404, "Recipe version not found");
  return revisionItem(row);
}
export async function listRecipes(userId: string): Promise<TaskRecipe[]> {
  return (
    await db
      .select()
      .from(taskRecipes)
      .where(eq(taskRecipes.userId, userId))
      .orderBy(desc(taskRecipes.updatedAt), desc(taskRecipes.id))
  ).map(recipeItem);
}
export async function getRecipe(userId: string, recipeId: string): Promise<RecipeDetail | null> {
  const recipe = await ownedRecipe(userId, recipeId);
  if (!recipe) return null;
  const versions = await db
    .select()
    .from(taskRecipeVersions)
    .where(eq(taskRecipeVersions.recipeId, recipeId))
    .orderBy(desc(taskRecipeVersions.version));
  return { recipe: recipeItem(recipe), versions: versions.map(revisionItem) };
}
export async function createRecipe(userId: string, input: unknown): Promise<TaskRecipe> {
  const spec = validateRecipeSpec(input);
  await validateReferences(userId, spec);
  const now = new Date(),
    id = generateId();
  const row = {
    id,
    userId,
    version: 1,
    spec: JSON.stringify(spec),
    createdAt: now,
    updatedAt: now,
  };
  await db.transaction(async (tx) => {
    await tx.insert(taskRecipes).values(row);
    await tx
      .insert(taskRecipeVersions)
      .values({ id: generateId(), recipeId: id, version: 1, spec: row.spec, createdAt: now });
  });
  return recipeItem(row);
}
const recipeWrites = new Map<string, Promise<void>>();
async function writeRecipe<T>(recipeId: string, action: () => Promise<T>): Promise<T> {
  const previous = recipeWrites.get(recipeId);
  let release = () => {};
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  recipeWrites.set(recipeId, pending);
  await previous;
  try {
    return await action();
  } finally {
    release();
    if (recipeWrites.get(recipeId) === pending) recipeWrites.delete(recipeId);
  }
}
export function updateRecipe(
  userId: string,
  recipeId: string,
  input: unknown,
  expectedVersion: unknown,
): Promise<TaskRecipe> {
  return writeRecipe(recipeId, () =>
    updateRecipeRevision(userId, recipeId, input, expectedVersion),
  );
}

async function updateRecipeRevision(
  userId: string,
  recipeId: string,
  input: unknown,
  expectedVersion: unknown,
): Promise<TaskRecipe> {
  if (!positiveVersion(expectedVersion))
    throw new RecipeServiceError("invalid_parameters", 400, "expectedVersion is required");
  const existing = await ownedRecipe(userId, recipeId);
  if (!existing) throw new RecipeServiceError("recipe_not_found", 404, "Recipe not found");
  const spec = validateRecipeSpec(input);
  await validateReferences(userId, spec);
  const now = new Date(),
    serialized = JSON.stringify(spec);
  await db.transaction(async (tx) => {
    const changed = await tx
      .update(taskRecipes)
      .set({ version: expectedVersion + 1, spec: serialized, updatedAt: now })
      .where(
        and(
          eq(taskRecipes.id, recipeId),
          eq(taskRecipes.userId, userId),
          eq(taskRecipes.version, expectedVersion),
        ),
      );
    if (changed.rowsAffected === 0)
      throw new RecipeServiceError("recipe_version_conflict", 409, "Recipe has a newer version");
    await tx.insert(taskRecipeVersions).values({
      id: generateId(),
      recipeId,
      version: expectedVersion + 1,
      spec: serialized,
      createdAt: now,
    });
  });
  return recipeItem({
    ...existing,
    version: expectedVersion + 1,
    spec: serialized,
    updatedAt: now,
  });
}
export async function restoreRecipe(
  userId: string,
  recipeId: string,
  sourceVersion: unknown,
  expectedVersion: unknown,
) {
  const source = await ownedVersion(userId, recipeId, sourceVersion);
  return updateRecipe(userId, recipeId, source.spec, expectedVersion);
}

export async function deleteRecipe(userId: string, recipeId: string): Promise<boolean> {
  return (
    (
      await db
        .delete(taskRecipes)
        .where(and(eq(taskRecipes.id, recipeId), eq(taskRecipes.userId, userId)))
    ).rowsAffected > 0
  );
}
export async function prepareRecipe(
  userId: string,
  recipeId: string,
  version: unknown,
  values: unknown,
): Promise<PreparedRecipe> {
  const revision = await ownedVersion(userId, recipeId, version);
  const rendered = renderRecipePrompt(revision.spec, values);
  const model = await executionReferences(userId, revision.spec);
  const conversation = await createConversation(userId, {
    title: revision.spec.title,
    forceNew: true,
    defaultMode: "agent",
    projectId: revision.spec.projectId,
    ...model,
    forceWebSearch: revision.spec.requirements.webSearch,
  });
  return {
    conversationId: conversation.id,
    prompt: rendered.prompt,
    requirements: revision.spec.requirements,
    recipeId,
    recipeVersion: revision.version,
  };
}
function scheduleOptions(value: unknown): RecipeScheduleOptions {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new RecipeServiceError("invalid_parameters", 400, "Invalid schedule options");
  const options = value as Record<string, unknown>;
  if (
    options.title !== undefined &&
    (typeof options.title !== "string" || !options.title.trim() || options.title.length > 160)
  )
    throw new RecipeServiceError("invalid_parameters", 400, "Invalid schedule title");
  if (options.notifyOnComplete !== undefined && typeof options.notifyOnComplete !== "boolean")
    throw new RecipeServiceError("invalid_parameters", 400, "Invalid notification preference");
  if (
    options.requestId !== undefined &&
    (typeof options.requestId !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(options.requestId))
  )
    throw new RecipeServiceError("invalid_parameters", 400, "Invalid schedule request identity");
  return {
    title: typeof options.title === "string" ? options.title.trim() : undefined,
    notifyOnComplete: options.notifyOnComplete as boolean | undefined,
    requestId: options.requestId as string | undefined,
  };
}
function scheduleIdentity(userId: string, requestId: string): string {
  const hex = createHash("sha256")
    .update(JSON.stringify(["openhorn-recipe-schedule", userId, requestId]))
    .digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
export async function scheduleRecipe(
  userId: string,
  recipeId: string,
  version: unknown,
  values: unknown,
  frequency: unknown,
  time: unknown,
  inputOptions: unknown = {},
) {
  const options = scheduleOptions(inputOptions);
  const revision = await ownedVersion(userId, recipeId, version);
  if (revision.spec.outputFormat !== "markdown")
    throw new RecipeServiceError(
      "unsupported_schedule_format",
      400,
      "Scheduled recipes currently require Markdown output",
    );
  const frequencies = [
    "daily",
    "weekly_mon",
    "weekly_tue",
    "weekly_wed",
    "weekly_thu",
    "weekly_fri",
    "weekly_sat",
    "weekly_sun",
  ];
  if (
    typeof frequency !== "string" ||
    !frequencies.includes(frequency) ||
    typeof time !== "string" ||
    !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)
  )
    throw new RecipeServiceError(
      "invalid_parameters",
      400,
      "Valid frequency and HH:mm time are required",
    );
  const rendered = renderRecipePrompt(revision.spec, values);
  const title = options.title ?? revision.spec.title;
  const notifyOnComplete = options.notifyOnComplete ?? true;
  const id = options.requestId ? scheduleIdentity(userId, options.requestId) : undefined;
  const existingResult = async () => {
    if (!id) return null;
    const task = await getScheduledTask(userId, id);
    if (!task) return null;
    const snapshot = task.recipeSnapshot;
    if (
      snapshot?.recipeId !== recipeId ||
      snapshot.version !== revision.version ||
      JSON.stringify(snapshot.values) !== JSON.stringify(rendered.values) ||
      task.prompt !== rendered.prompt ||
      task.title !== title ||
      task.frequency !== frequency ||
      task.time !== time ||
      task.notifyOnComplete !== notifyOnComplete
    ) {
      throw new RecipeServiceError(
        "invalid_parameters",
        400,
        "Schedule request identity was already used with different inputs",
      );
    }
    return task;
  };
  const create = async () => {
    const existing = await existingResult();
    if (existing) return existing;
    const model = await executionReferences(userId, revision.spec);
    const snapshot: FrozenRecipeSnapshot = {
      recipeId,
      version: revision.version,
      spec: { ...revision.spec, ...model },
      values: rendered.values,
      renderedPrompt: rendered.prompt,
    };
    try {
      return await createScheduledTask(
        userId,
        {
          title,
          prompt: rendered.prompt,
          frequency: frequency as ScheduledTaskFrequency,
          time,
          ...model,
          projectId: revision.spec.projectId,
          recipeSnapshot: snapshot,
          notifyOnComplete,
        },
        id,
      );
    } catch (error) {
      // Another process can have committed the same idempotent confirmation.
      const committed = await existingResult();
      if (committed) return committed;
      throw error;
    }
  };
  return id ? writeRecipe(`schedule:${id}`, create) : create();
}

export function recipeError(error: unknown): {
  status: 400 | 404 | 409;
  errorCode: string;
  message: string;
} {
  if (error instanceof RecipeServiceError)
    return { status: error.status, errorCode: error.code, message: error.message };
  if (error instanceof RecipeValidationError)
    return { status: 400, errorCode: error.code, message: error.message };
  if (error instanceof SyntaxError)
    return { status: 400, errorCode: "invalid_recipe", message: "Invalid JSON body" };
  throw error;
}
