import { expect, test } from "bun:test";
import type { ScheduledTask, ScheduledTaskRun } from "shared/types";
import { createScheduledTaskStore } from "./scheduledTaskStore";

const task = {
  id: "task-one",
  title: "Synthetic task",
  enabled: false,
  frequency: "daily",
  time: "09:00",
  prompt: "Synthetic",
  userId: "synthetic-user",
  notifyOnComplete: true,
  createdAt: new Date(),
  updatedAt: new Date(),
} as ScheduledTask;
const run = {
  id: "run-one",
  taskId: task.id,
  status: "completed",
  startedAt: new Date(),
} as ScheduledTaskRun;

test("failed deletes and toggles preserve task/run state and report failure", async () => {
  const store = createScheduledTaskStore(async () =>
    Response.json({ error: "synthetic" }, { status: 503 }),
  );
  store.setState({ tasks: [task], runs: [run], taskRuns: { [task.id]: [run] } });
  expect(await store.getState().deleteTask(task.id)).toBe(false);
  expect(await store.getState().deleteRun(run.id)).toBe(false);
  expect(await store.getState().toggleTask(task.id)).toBe(false);
  expect(store.getState().tasks).toEqual([task]);
  expect(store.getState().runs).toEqual([run]);
  expect(store.getState().taskRuns[task.id]).toEqual([run]);
  expect(store.getState().pendingTasks).toEqual({});
  expect(store.getState().pendingRuns).toEqual({});
});

test("overlapping actions on a task submit once and release pending state", async () => {
  let resolve!: (response: Response) => void;
  const response = new Promise<Response>((done) => {
    resolve = done;
  });
  let calls = 0;
  const store = createScheduledTaskStore(async () => {
    calls++;
    return response;
  });
  store.setState({ tasks: [task] });
  const first = store.getState().toggleTask(task.id);
  expect(store.getState().pendingTasks[task.id]).toBe("toggle");
  expect(await store.getState().toggleTask(task.id)).toBe(false);
  expect(await store.getState().deleteTask(task.id)).toBe(false);
  expect(await store.getState().runTaskNow(task.id)).toBe(null);
  expect(calls).toBe(1);
  resolve(Response.json({ task: { ...task, enabled: true } }));
  expect(await first).toBe(true);
  expect(store.getState().tasks[0].enabled).toBe(true);
  expect(store.getState().pendingTasks).toEqual({});
});

test("task deletion removes associated cached runs only after success", async () => {
  const store = createScheduledTaskStore(async () => Response.json({ success: true }));
  const other = { ...run, id: "other-run", taskId: "other-task" };
  store.setState({
    tasks: [task],
    runs: [run, other],
    taskRuns: { [task.id]: [run], "other-task": [other] },
  });
  expect(await store.getState().deleteTask(task.id)).toBe(true);
  expect(store.getState().tasks).toEqual([]);
  expect(store.getState().runs).toEqual([other]);
  expect(store.getState().taskRuns[task.id]).toBe(undefined);
});

test("list failures stay distinct from empty data and recover on retry", async () => {
  let fail = true;
  const store = createScheduledTaskStore(async (url) =>
    fail
      ? Response.json({}, { status: 500 })
      : Response.json(url.endsWith("/runs") ? { runs: [run] } : { tasks: [task] }),
  );
  await store.getState().loadTasks();
  expect(!!store.getState().error).toBe(true);
  expect(await store.getState().loadRuns()).toBe(false);
  expect(!!store.getState().runsErrors[""]).toBe(true);
  expect(store.getState().runsLoading[""]).toBe(false);
  fail = false;
  await store.getState().loadTasks();
  expect(await store.getState().loadRuns()).toBe(true);
  expect(store.getState().error).toBe(null);
  expect(store.getState().runsErrors[""]).toBe(null);
});

test("late list responses cannot resurrect a successfully deleted task or run", async () => {
  const pending: Array<(response: Response) => void> = [];
  const store = createScheduledTaskStore(async (_url, init) =>
    init?.method === "DELETE"
      ? Response.json({ success: true })
      : new Promise<Response>((done) => pending.push(done)),
  );
  store.setState({ tasks: [task], runs: [run] });
  const tasks = store.getState().loadTasks();
  const runs = store.getState().loadRuns();
  await store.getState().deleteTask(task.id);
  pending[0](Response.json({ tasks: [task] }));
  pending[1](Response.json({ runs: [run] }));
  await Promise.all([tasks, runs]);
  expect(store.getState().tasks).toEqual([]);
  expect(store.getState().runs).toEqual([]);
  expect(store.getState().loading).toBe(false);
  expect(store.getState().runsLoading[""]).toBe(false);
});
