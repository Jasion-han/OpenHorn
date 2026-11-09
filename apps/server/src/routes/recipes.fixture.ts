import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const directory = mkdtempSync(path.join(tmpdir(), "openhorn-recipes-http-"));
process.env.NODE_ENV = "test";
process.env.DATABASE_URL = `file:${path.join(directory, "isolated.db")}`;
const { client } = await import("../db");
try {
  const { Hono } = await import("hono");
  const { bootstrapDatabase } = await import("../db/bootstrap");
  await bootstrapDatabase({ backup: null });
  const { default: routes } = await import("./recipes");
  const { default: scheduledRoutes } = await import("./scheduledTasks");
  const app = new Hono().route("/recipes", routes).route("/scheduled-tasks", scheduledRoutes);
  const userId = String((await client.execute("SELECT id FROM users LIMIT 1")).rows[0].id);
  await client.execute({
    sql: "INSERT INTO projects(id,user_id,name,root_path,is_starred,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
    args: ["synthetic-project", userId, "Synthetic", "/synthetic/project", 0, 1, 1],
  });
  await client.execute({
    sql: "INSERT INTO channels(id,user_id,name,provider,protocol,api_key,enabled,is_default,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
    args: [
      "synthetic-channel",
      userId,
      "Synthetic",
      "openai",
      "openai",
      "synthetic-not-decrypted",
      1,
      1,
      1,
      1,
    ],
  });
  await client.execute({
    sql: "INSERT INTO channel_models(id,channel_id,model_id,display_name,enabled,is_default,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
    args: ["synthetic-model-row", "synthetic-channel", "synthetic-model", "Synthetic", 1, 1, 1, 1],
  });
  const spec = {
    title: "Synthetic recipe",
    description: "",
    promptTemplate: "Inspect {{file}}",
    parameters: [{ key: "file", label: "File", type: "text", required: true }],
    requirements: { skills: [], mcpServers: [], workspace: true, webSearch: false },
    projectId: "synthetic-project",
    outputFormat: "markdown",
  };
  type Data = {
    recipe?: { id: string; version: number; createdAt: string; spec: { title: string } };
    recipes?: unknown[];
    versions?: unknown[];
    errorCode?: string;
    prompt?: string;
    conversationId?: string;
    task?: {
      id: string;
      projectId: string;
      createdAt: string;
      recipeSnapshot: { version: number };
    };
  };
  async function request(url: string, method = "GET", body?: unknown) {
    const response = await app.request(url, {
      method,
      ...(body === undefined
        ? {}
        : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    });
    return { status: response.status, body: (await response.json()) as Data };
  }
  const invalid = await request("/recipes", "POST", null);
  const created = await request("/recipes", "POST", { spec });
  const id = created.body.recipe?.id;
  if (!id) throw new Error("Recipe not created");
  const list = await request("/recipes");
  const update = await request(`/recipes/${id}`, "PUT", {
    spec: { ...spec, title: "Second" },
    expectedVersion: 1,
  });
  const stale = await request(`/recipes/${id}`, "PUT", { spec, expectedVersion: 1 });
  const invalidInputs = await request(`/recipes/${id}/prepare`, "POST", { version: 1, values: {} });
  const prepared = await request(`/recipes/${id}/prepare`, "POST", {
    version: 1,
    values: { file: "a.csv" },
  });
  const detail = await request(`/recipes/${id}`);
  const scheduleInput = {
    version: 1,
    values: { file: "a.csv" },
    frequency: "daily",
    time: "09:30",
    title: "Custom route schedule",
    notifyOnComplete: false,
    requestId: crypto.randomUUID(),
  };
  const schedule = await request(`/recipes/${id}/schedule`, "POST", scheduleInput);
  const retrySchedule = await request(`/recipes/${id}/schedule`, "POST", scheduleInput);
  const manual = await request(`/scheduled-tasks/${schedule.body.task?.id}/run`, "POST");
  const manualProject = manual.body.conversationId
    ? (
        await client.execute({
          sql: "SELECT project_id FROM conversations WHERE id=?",
          args: [manual.body.conversationId],
        })
      ).rows[0]?.project_id
    : null;
  const removed = await request(`/recipes/${id}`, "DELETE");
  const missing = await request(`/recipes/${id}`);
  console.log(
    JSON.stringify({
      invalid,
      created,
      list,
      update,
      stale,
      invalidInputs,
      prepared,
      detail,
      schedule,
      retrySchedule,
      manualProject,
      removed,
      missing,
    }),
  );
  const { stopScheduler } = await import("../services/scheduledTaskScheduler");
  stopScheduler();
} finally {
  client.close();
  rmSync(directory, { recursive: true, force: true });
}
