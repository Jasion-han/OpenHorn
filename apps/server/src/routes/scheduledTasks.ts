import { Hono } from "hono";
import {
  advanceNextRunAt,
  completeTaskRun,
  createScheduledTask,
  createTaskRun,
  deleteScheduledTask,
  deleteTaskRun,
  getScheduledTask,
  listScheduledTasks,
  listTaskRuns,
  toggleScheduledTask,
  updateScheduledTask,
} from "../services/scheduledTaskService";
import { requireUser, type UserEnv } from "../utils/requestUser";

const router = new Hono<UserEnv>();

router.use("*", requireUser);

router.get("/", async (c) => {
  const user = c.get("user");
  const tasks = await listScheduledTasks(user.id);
  return c.json({ tasks });
});

router.post("/", async (c) => {
  const user = c.get("user");
  const body = await c.req.json<{
    title: string;
    prompt: string;
    frequency: string;
    time: string;
    notifyOnComplete?: boolean;
    channelId?: string;
    modelId?: string;
  }>();

  if (!body.title?.trim() || !body.prompt?.trim() || !body.frequency || !body.time) {
    return c.json({ error: "title, prompt, frequency, and time are required" }, 400);
  }

  const task = await createScheduledTask(user.id, {
    title: body.title.trim(),
    prompt: body.prompt.trim(),
    frequency: body.frequency as Parameters<typeof createScheduledTask>[1]["frequency"],
    time: body.time,
    notifyOnComplete: body.notifyOnComplete,
    channelId: body.channelId,
    modelId: body.modelId,
  });
  return c.json({ task }, 201);
});

router.put("/:id", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const body = await c.req.json();

  const task = await updateScheduledTask(user.id, id, body);
  if (!task) return c.json({ error: "not found" }, 404);
  return c.json({ task });
});

router.delete("/:id", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  await deleteScheduledTask(user.id, id);
  return c.json({ success: true });
});

router.patch("/:id/toggle", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const task = await toggleScheduledTask(user.id, id);
  if (!task) return c.json({ error: "not found" }, 404);
  return c.json({ task });
});

router.post("/:id/run", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const task = await getScheduledTask(user.id, id);
  if (!task) return c.json({ error: "not found" }, 404);

  const runId = await createTaskRun(task.id, user.id);
  try {
    await advanceNextRunAt(task.id);
    await completeTaskRun(runId, {
      status: "completed",
      result: `[手动触发] ${task.title}\n\nPrompt: ${task.prompt}\n\n(Agent 执行功能将在后续版本接入)`,
    });
  } catch (err) {
    await completeTaskRun(runId, {
      status: "failed",
      error: err instanceof Error ? err.message : "Unknown error",
    });
  }
  return c.json({ success: true, runId });
});

router.get("/:id/runs", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const runs = await listTaskRuns(user.id, id);
  return c.json({ runs });
});

router.get("/runs", async (c) => {
  const user = c.get("user");
  const runs = await listTaskRuns(user.id);
  return c.json({ runs });
});

router.delete("/runs/:runId", async (c) => {
  const user = c.get("user");
  const runId = c.req.param("runId");
  await deleteTaskRun(user.id, runId);
  return c.json({ success: true });
});

export default router;
