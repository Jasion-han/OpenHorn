import { expect, test } from "bun:test";
import {
  channelModels,
  channels,
  conversations,
  projects,
  scheduledTaskRuns,
  scheduledTasks,
  taskRecipes,
  users,
} from "db";
import { eq } from "drizzle-orm";
import type { RecipeSpec } from "shared/types";
import { db } from "../db";
import {
  createRecipe,
  deleteRecipe,
  getRecipe,
  listRecipes,
  prepareRecipe,
  restoreRecipe,
  scheduleRecipe,
  updateRecipe,
} from "./recipeService";

async function fixture() {
  const userId = crypto.randomUUID();
  const projectId = crypto.randomUUID();
  const now = new Date();
  await db.insert(users).values({
    id: userId,
    email: `${userId}@test.local`,
    username: "recipe",
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(projects).values({
    id: projectId,
    userId,
    name: "Synthetic workspace",
    rootPath: `/synthetic/${projectId}`,
    isStarred: false,
    createdAt: now,
    updatedAt: now,
  });
  const spec: RecipeSpec = {
    title: "Synthetic",
    description: "",
    promptTemplate: "Review {{file}}",
    parameters: [{ key: "file", label: "File", type: "text", required: true }],
    requirements: { skills: [], mcpServers: [], workspace: true, webSearch: false },
    projectId,
    outputFormat: "markdown",
  };
  return {
    userId,
    projectId,
    spec,
    async cleanup() {
      await db.delete(scheduledTaskRuns).where(eq(scheduledTaskRuns.userId, userId));
      await db.delete(scheduledTasks).where(eq(scheduledTasks.userId, userId));
      await db.delete(taskRecipes).where(eq(taskRecipes.userId, userId));
      await db.delete(conversations).where(eq(conversations.userId, userId));
      await db.delete(projects).where(eq(projects.userId, userId));
      await db.delete(users).where(eq(users.id, userId));
    },
  };
}
async function rejectsCode(action: () => Promise<unknown>, code: string) {
  let error: unknown;
  try {
    await action();
  } catch (caught) {
    error = caught;
  }
  expect((error as { code?: string })?.code).toBe(code);
}

test("restore creates a new recipe revision without modifying existing versions or frozen tasks", async () => {
  const f = await fixture();
  try {
    const first = await createRecipe(f.userId, f.spec);
    const snapshot = JSON.stringify({
      recipeId: first.id,
      version: 1,
      spec: first.spec,
      values: { file: "a.ts" },
      renderedPrompt: "Review a.ts",
    });
    await db.insert(scheduledTasks).values({
      id: `${first.id}-frozen`,
      userId: f.userId,
      title: "Frozen",
      prompt: "Review a.ts",
      frequency: "daily",
      time: "09:00",
      enabled: false,
      recipeSnapshot: snapshot,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const second = await updateRecipe(
      f.userId,
      first.id,
      { ...f.spec, title: "New title", promptTemplate: "Changed {{file}}" },
      1,
    );
    const restored = await restoreRecipe(f.userId, first.id, 1, second.version);
    expect(restored.version).toBe(3);
    expect(restored.spec).toEqual(first.spec);
    expect(
      (
        await db
          .select()
          .from(scheduledTasks)
          .where(eq(scheduledTasks.id, `${first.id}-frozen`))
      )[0]?.recipeSnapshot,
    ).toBe(snapshot);
    const history = await getRecipe(f.userId, first.id);
    expect(history?.versions).toHaveLength(3);
    expect(history?.versions.find((v) => v.version === 2)?.spec.title).toBe("New title");
    await rejectsCode(() => restoreRecipe("foreign", first.id, 1, 3), "recipe_not_found");
    await rejectsCode(() => restoreRecipe(f.userId, first.id, 1, 2), "recipe_version_conflict");
    await rejectsCode(() => restoreRecipe(f.userId, first.id, 0, 3), "invalid_parameters");
    await db.delete(projects).where(eq(projects.id, f.projectId));
    await rejectsCode(() => restoreRecipe(f.userId, first.id, 1, 3), "project_not_found");
    expect((await getRecipe(f.userId, first.id))?.recipe.version).toBe(3);
  } finally {
    await f.cleanup();
  }
});

test("recipe CRUD is user-scoped with immutable historical versions and compare-and-swap", async () => {
  const a = await fixture(),
    b = await fixture();
  try {
    const original = await createRecipe(a.userId, a.spec);
    expect((await listRecipes(a.userId)).map((row) => row.id)).toEqual([original.id]);
    expect(await getRecipe(b.userId, original.id)).toBe(null);
    await rejectsCode(() => createRecipe(b.userId, a.spec), "project_not_found");
    const updated = await updateRecipe(
      a.userId,
      original.id,
      { ...a.spec, title: "Revision two" },
      1,
    );
    expect(updated.version).toBe(2);
    await rejectsCode(
      () => updateRecipe(a.userId, original.id, a.spec, 1),
      "recipe_version_conflict",
    );
    const detail = await getRecipe(a.userId, original.id);
    expect(detail?.versions.map((row) => row.spec.title)).toEqual(["Revision two", "Synthetic"]);
    expect(detail?.recipe.createdAt.endsWith("Z")).toBe(true);
    expect(await deleteRecipe(b.userId, original.id)).toBe(false);
    expect(await deleteRecipe(a.userId, original.id)).toBe(true);
  } finally {
    await a.cleanup();
    await b.cleanup();
  }
});

test("historical prepare uses literal frozen inputs and creates a fresh project Agent conversation", async () => {
  const f = await fixture();
  const configured = await recipeChannels(f.userId);
  try {
    const recipe = await createRecipe(f.userId, f.spec);
    await updateRecipe(f.userId, recipe.id, { ...f.spec, promptTemplate: "New {{file}}" }, 1);
    const prepared = await prepareRecipe(f.userId, recipe.id, 1, { file: "a.csv" });
    expect(prepared.prompt.startsWith("Review a.csv")).toBe(true);
    expect(prepared.recipeVersion).toBe(1);
    const second = await prepareRecipe(f.userId, recipe.id, 1, { file: "b.csv" });
    expect(second.conversationId === prepared.conversationId).toBe(false);
    const [conversation] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, prepared.conversationId));
    expect(conversation.projectId).toBe(f.projectId);
    expect(conversation.defaultMode).toBe("agent");
    expect(conversation.forceWebSearch).toBe(false);
    await rejectsCode(() => prepareRecipe(f.userId, recipe.id, 1, {}), "invalid_parameters");
  } finally {
    await configured.cleanup();
    await f.cleanup();
  }
});

test("schedules preserve project and full version snapshot, reject unsupported formats and missing workspace", async () => {
  const f = await fixture();
  const configured = await recipeChannels(f.userId);
  try {
    await rejectsCode(
      () => createRecipe(f.userId, { ...f.spec, projectId: undefined }),
      "project_not_found",
    );
    const recipe = await createRecipe(f.userId, f.spec);
    const task = await scheduleRecipe(f.userId, recipe.id, 1, { file: "a.csv" }, "daily", "09:30");
    expect(task.projectId).toBe(f.projectId);
    expect(task.recipeSnapshot?.spec.title).toBe("Synthetic");
    expect(task.recipeSnapshot?.values).toEqual({ file: "a.csv" });
    await updateRecipe(f.userId, recipe.id, { ...f.spec, promptTemplate: "Changed {{file}}" }, 1);
    expect(task.recipeSnapshot?.version).toBe(1);
    expect(task.prompt.startsWith("Review a.csv")).toBe(true);
    const html = await createRecipe(f.userId, { ...f.spec, outputFormat: "html" });
    await rejectsCode(
      () => scheduleRecipe(f.userId, html.id, 1, { file: "a" }, "daily", "09:30"),
      "unsupported_schedule_format",
    );
    await rejectsCode(
      () => scheduleRecipe(f.userId, recipe.id, 1, { file: "a" }, "daily", "99:99"),
      "invalid_parameters",
    );
  } finally {
    await configured.cleanup();
    await f.cleanup();
  }
});

test("concurrent updates admit one immutable revision and missing projects reject historical execution", async () => {
  const f = await fixture();
  try {
    const recipe = await createRecipe(f.userId, f.spec);
    const attempts = await Promise.allSettled([
      updateRecipe(f.userId, recipe.id, { ...f.spec, title: "First" }, 1),
      updateRecipe(f.userId, recipe.id, { ...f.spec, title: "Second" }, 1),
    ]);
    expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = attempts.find((result) => result.status === "rejected");
    expect(rejected?.status === "rejected" ? rejected.reason.code : null).toBe(
      "recipe_version_conflict",
    );
    expect((await getRecipe(f.userId, recipe.id))?.versions).toHaveLength(2);
    await db.delete(projects).where(eq(projects.id, f.projectId));
    await rejectsCode(
      () => prepareRecipe(f.userId, recipe.id, 1, { file: "a" }),
      "project_not_found",
    );
  } finally {
    await f.cleanup();
  }
});

async function recipeChannels(userId: string) {
  const now = new Date();
  const a = crypto.randomUUID(),
    b = crypto.randomUUID();
  for (const [id, isDefault] of [
    [a, true],
    [b, false],
  ] as const) {
    await db.insert(channels).values({
      id,
      userId,
      name: id,
      provider: "openai",
      protocol: "openai",
      apiKey: "synthetic-not-decrypted",
      enabled: true,
      isDefault,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(channelModels).values({
      id: crypto.randomUUID(),
      channelId: id,
      modelId: `model-${id}`,
      displayName: "Synthetic",
      enabled: true,
      isDefault: true,
      createdAt: now,
      updatedAt: now,
    });
  }
  return {
    a,
    b,
    modelB: `model-${b}`,
    async cleanup() {
      for (const id of [a, b]) {
        await db.delete(channelModels).where(eq(channelModels.channelId, id));
        await db.delete(channels).where(eq(channels.id, id));
      }
    },
  };
}

test("selected non-global channel resolves its strict default pair for prepare and frozen scheduling", async () => {
  const f = await fixture();
  const channels = await recipeChannels(f.userId);
  try {
    const recipe = await createRecipe(f.userId, { ...f.spec, channelId: channels.b });
    const prepared = await prepareRecipe(f.userId, recipe.id, 1, { file: "a" });
    const [conversation] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, prepared.conversationId));
    expect(conversation.channelId).toBe(channels.b);
    expect(conversation.modelId).toBe(channels.modelB);
    const task = await scheduleRecipe(f.userId, recipe.id, 1, { file: "a" }, "daily", "09:30");
    expect(task.channelId).toBe(channels.b);
    expect(task.modelId).toBe(channels.modelB);
    expect(task.recipeSnapshot?.spec.modelId).toBe(channels.modelB);
  } finally {
    await channels.cleanup();
    await f.cleanup();
  }
});

test("explicit models that become disabled are rejected rather than silently switching to the global channel", async () => {
  const f = await fixture();
  const configured = await recipeChannels(f.userId);
  try {
    const recipe = await createRecipe(f.userId, {
      ...f.spec,
      channelId: configured.b,
      modelId: configured.modelB,
    });
    await db
      .update(channelModels)
      .set({ enabled: false })
      .where(eq(channelModels.channelId, configured.b));
    await rejectsCode(
      () => prepareRecipe(f.userId, recipe.id, 1, { file: "a" }),
      "channel_not_found",
    );
    await rejectsCode(
      () => scheduleRecipe(f.userId, recipe.id, 1, { file: "a" }, "daily", "09:30"),
      "channel_not_found",
    );
    const other = await fixture();
    try {
      await rejectsCode(
        () => createRecipe(other.userId, { ...other.spec, channelId: configured.b }),
        "channel_not_found",
      );
    } finally {
      await other.cleanup();
    }
  } finally {
    await configured.cleanup();
    await f.cleanup();
  }
});

test("recipes using the global default bind a complete channel/model pair for execution", async () => {
  const f = await fixture();
  const available = await recipeChannels(f.userId);
  try {
    const recipe = await createRecipe(f.userId, f.spec);
    const prepared = await prepareRecipe(f.userId, recipe.id, 1, { file: "a.csv" });
    const [conversation] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, prepared.conversationId));
    expect(conversation.channelId).toBe(available.a);
    expect(conversation.modelId).toBe(`model-${available.a}`);
    const task = await scheduleRecipe(f.userId, recipe.id, 1, { file: "a.csv" }, "daily", "09:30");
    expect(task.channelId).toBe(available.a);
    expect(task.modelId).toBe(`model-${available.a}`);
    expect(task.recipeSnapshot?.spec.channelId).toBe(available.a);
    expect(task.recipeSnapshot?.spec.modelId).toBe(`model-${available.a}`);
  } finally {
    await available.cleanup();
    await f.cleanup();
  }
});

test("unconfigured global defaults reject before creating recipe execution state", async () => {
  const f = await fixture();
  try {
    const recipe = await createRecipe(f.userId, f.spec);
    await rejectsCode(
      () => prepareRecipe(f.userId, recipe.id, 1, { file: "a.csv" }),
      "channel_not_found",
    );
    await rejectsCode(
      () => scheduleRecipe(f.userId, recipe.id, 1, { file: "a.csv" }, "daily", "09:30"),
      "channel_not_found",
    );
    expect(
      await db.select().from(conversations).where(eq(conversations.userId, f.userId)),
    ).toHaveLength(0);
    expect(
      await db.select().from(scheduledTasks).where(eq(scheduledTasks.userId, f.userId)),
    ).toHaveLength(0);
  } finally {
    await f.cleanup();
  }
});

test("schedule options keep recipe identity immutable and retries/double submissions create one task", async () => {
  const f = await fixture();
  const configured = await recipeChannels(f.userId);
  try {
    const recipe = await createRecipe(f.userId, f.spec);
    const options = {
      title: "Custom schedule name",
      notifyOnComplete: false,
      requestId: crypto.randomUUID(),
    };
    const [first, duplicate] = await Promise.all([
      scheduleRecipe(f.userId, recipe.id, 1, { file: "a.csv" }, "daily", "09:30", options),
      scheduleRecipe(f.userId, recipe.id, 1, { file: "a.csv" }, "daily", "09:30", options),
    ]);
    expect(first?.id).toBe(duplicate?.id);
    expect(first?.title).toBe("Custom schedule name");
    expect(first?.notifyOnComplete).toBe(false);
    expect(first?.recipeSnapshot?.spec.title).toBe("Synthetic");
    expect((await getRecipe(f.userId, recipe.id))?.recipe.spec.title).toBe("Synthetic");
    expect(
      await db.select().from(scheduledTasks).where(eq(scheduledTasks.userId, f.userId)),
    ).toHaveLength(1);
    await rejectsCode(
      () => scheduleRecipe(f.userId, recipe.id, 1, { file: "a.csv" }, "daily", "10:30", options),
      "invalid_parameters",
    );
    await rejectsCode(
      () =>
        scheduleRecipe(f.userId, recipe.id, 1, { file: "a.csv" }, "daily", "09:30", {
          notifyOnComplete: "false",
        }),
      "invalid_parameters",
    );
  } finally {
    await configured.cleanup();
    await f.cleanup();
  }
});

test("restored channels without configured credentials reject execution before creating state", async () => {
  const f = await fixture();
  const configured = await recipeChannels(f.userId);
  try {
    const recipe = await createRecipe(f.userId, { ...f.spec, channelId: configured.b });
    await db.update(channels).set({ apiKey: "" }).where(eq(channels.id, configured.b));
    await rejectsCode(
      () => prepareRecipe(f.userId, recipe.id, 1, { file: "a" }),
      "channel_not_found",
    );
    await rejectsCode(
      () => scheduleRecipe(f.userId, recipe.id, 1, { file: "a" }, "daily", "09:30"),
      "channel_not_found",
    );
    expect(
      await db.select().from(conversations).where(eq(conversations.userId, f.userId)),
    ).toHaveLength(0);
    expect(
      await db.select().from(scheduledTasks).where(eq(scheduledTasks.userId, f.userId)),
    ).toHaveLength(0);
  } finally {
    await configured.cleanup();
    await f.cleanup();
  }
});
