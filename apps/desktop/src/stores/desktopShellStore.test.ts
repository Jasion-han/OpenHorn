import { describe, expect, test } from "bun:test";
import { createDesktopShellStore } from "./desktopShellStore";

describe("desktop shell store", () => {
  test("task history navigation scopes runs and clears the scope for the full list", () => {
    const store = createDesktopShellStore();
    store.getState().openRunDetail("old-run");
    store.getState().openScheduledTasks("runs", "task-a");
    expect(store.getState()).toMatchObject({
      activeView: "scheduled-tasks",
      scheduledTasksTab: "runs",
      scheduledTaskRunsTaskId: "task-a",
      selectedRunId: null,
    });

    store.getState().openScheduledTasks("runs", "task-b");
    expect(store.getState().scheduledTaskRunsTaskId).toBe("task-b");
    store.getState().openScheduledTasks("runs");
    expect(store.getState().scheduledTaskRunsTaskId).toBe(null);
  });

  test("opening tasks and resetting both clear the task history scope", () => {
    const store = createDesktopShellStore();
    store.getState().openScheduledTasks("runs", "task-a");
    store.getState().openScheduledTasks();
    expect(store.getState().scheduledTaskRunsTaskId).toBe(null);
    expect(store.getState().scheduledTasksTab).toBe("tasks");
    store.getState().openScheduledTasks("runs", "task-a");
    store.getState().reset();
    expect(store.getState().scheduledTaskRunsTaskId).toBe(null);
  });

  test("fullAccessEnabled defaults to false", () => {
    const store = createDesktopShellStore();
    expect(store.getState().fullAccessEnabled).toBe(false);
  });

  test("toggleFullAccess flips fullAccessEnabled", () => {
    const store = createDesktopShellStore();

    store.getState().toggleFullAccess();
    expect(store.getState().fullAccessEnabled).toBe(true);

    store.getState().toggleFullAccess();
    expect(store.getState().fullAccessEnabled).toBe(false);
  });

  test("reset restores fullAccessEnabled to false", () => {
    const store = createDesktopShellStore();

    store.getState().toggleFullAccess();
    expect(store.getState().fullAccessEnabled).toBe(true);

    store.getState().reset();
    expect(store.getState().fullAccessEnabled).toBe(false);
  });
});
