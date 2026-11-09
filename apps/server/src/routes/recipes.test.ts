import { expect, test } from "bun:test";

test("recipe routes return versioned ISO DTOs and prepare/schedule without running models", () => {
  const child = Bun.spawnSync(
    [process.execPath, new URL("./recipes.fixture.ts", import.meta.url).pathname],
    {
      env: { ...process.env, NODE_ENV: "test", DATABASE_URL: "file::memory:" },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 15000,
    },
  );
  expect(child.exitCode).toBe(0);
  const result = JSON.parse(child.stdout.toString());
  expect(result.invalid.status).toBe(400);
  expect(result.invalid.body.errorCode).toBe("invalid_recipe");
  expect(result.created.status).toBe(201);
  expect(result.created.body.recipe.createdAt.endsWith("Z")).toBe(true);
  expect(result.list.body.recipes).toHaveLength(1);
  expect(result.update.body.recipe.version).toBe(2);
  expect(result.stale.status).toBe(409);
  expect(result.stale.body.errorCode).toBe("recipe_version_conflict");
  expect(result.invalidInputs.body.errorCode).toBe("invalid_parameters");
  expect(result.prepared.body.prompt.startsWith("Inspect a.csv")).toBe(true);
  expect(result.detail.body.versions).toHaveLength(2);
  expect(result.schedule.body.task.projectId).toBe("synthetic-project");
  expect(result.schedule.body.task.title).toBe("Custom route schedule");
  expect(result.schedule.body.task.notifyOnComplete).toBe(false);
  expect(result.retrySchedule.body.task.id).toBe(result.schedule.body.task.id);
  expect(result.schedule.body.task.recipeSnapshot.version).toBe(1);
  expect(result.schedule.body.task.createdAt.endsWith("Z")).toBe(true);
  expect(result.manualProject).toBe("synthetic-project");
  expect(result.removed.status).toBe(200);
  expect(result.missing.body.errorCode).toBe("recipe_not_found");
});
