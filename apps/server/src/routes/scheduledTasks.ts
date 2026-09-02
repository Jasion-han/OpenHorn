import { Hono } from "hono";
import { getResolvedChannelForUser } from "../services/channelService";
import { createConversation } from "../services/conversationService";
import { rescheduleScheduler } from "../services/scheduledTaskScheduler";
import {
  advanceNextRunAt,
  claimTaskRun,
  completeTaskRun,
  createScheduledTask,
  createTaskRun,
  deleteScheduledTask,
  deleteTaskRun,
  finishTaskRun,
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
  rescheduleScheduler();
  return c.json({ task }, 201);
});

router.put("/:id", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const body = await c.req.json();

  const task = await updateScheduledTask(user.id, id, body);
  if (!task) return c.json({ error: "not found" }, 404);
  rescheduleScheduler();
  return c.json({ task });
});

router.delete("/:id", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  await deleteScheduledTask(user.id, id);
  rescheduleScheduler();
  return c.json({ success: true });
});

router.patch("/:id/toggle", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const task = await toggleScheduledTask(user.id, id);
  if (!task) return c.json({ error: "not found" }, 404);
  rescheduleScheduler();
  return c.json({ task });
});

router.post("/:id/run", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const task = await getScheduledTask(user.id, id);
  if (!task) return c.json({ error: "not found" }, 404);

  let channelId = task.channelId;
  let modelId = task.modelId;
  if (!channelId) {
    const resolved = await getResolvedChannelForUser(user.id);
    if (resolved) {
      channelId = resolved.channel.id;
      modelId = resolved.modelId;
    }
  }
  const conversation = await createConversation(user.id, {
    title: task.title,
    channelId,
    modelId,
    forceNew: true,
  });
  const runId = await createTaskRun(task.id, user.id, conversation.id);
  await completeTaskRun(runId, { status: "completed" });
  await advanceNextRunAt(task.id);
  rescheduleScheduler();
  return c.json({ success: true, runId, conversationId: conversation.id });
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

// Desktop-side execution of a scheduler-created run: claim it (pending →
// running, first caller wins), then report the outcome once the agent turn
// has been persisted through the regular sync-sidecar path.
router.patch("/runs/:runId/claim", async (c) => {
  const user = c.get("user");
  const runId = c.req.param("runId");
  const claimed = await claimTaskRun(user.id, runId);
  return c.json({ claimed });
});

router.patch("/runs/:runId/complete", async (c) => {
  const user = c.get("user");
  const runId = c.req.param("runId");
  const body = await c.req.json<{ status?: string; result?: string; error?: string }>();
  if (body.status !== "completed" && body.status !== "failed") {
    return c.json({ error: "status must be completed or failed" }, 400);
  }
  const updated = await finishTaskRun(user.id, runId, {
    status: body.status,
    result: typeof body.result === "string" ? body.result : undefined,
    error: typeof body.error === "string" ? body.error : undefined,
  });
  if (!updated) return c.json({ error: "not found" }, 404);
  return c.json({ success: true });
});

router.delete("/runs/:runId", async (c) => {
  const user = c.get("user");
  const runId = c.req.param("runId");
  await deleteTaskRun(user.id, runId);
  return c.json({ success: true });
});

export default router;
