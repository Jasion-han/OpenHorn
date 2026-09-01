import type { ScheduledTask, ScheduledTaskFrequency, ScheduledTaskRun } from "shared/types";
import { create } from "zustand";
import { getDesktopBackendBase } from "../lib/backendBase";

interface ScheduledTaskState {
  tasks: ScheduledTask[];
  runs: ScheduledTaskRun[];
  loading: boolean;
  error: string | null;

  loadTasks: () => Promise<void>;
  loadRuns: () => Promise<void>;
  createTask: (data: {
    title: string;
    prompt: string;
    frequency: ScheduledTaskFrequency;
    time: string;
    notifyOnComplete?: boolean;
  }) => Promise<ScheduledTask | null>;
  updateTask: (
    id: string,
    data: Partial<{
      title: string;
      prompt: string;
      frequency: ScheduledTaskFrequency;
      time: string;
      notifyOnComplete: boolean;
    }>,
  ) => Promise<ScheduledTask | null>;
  deleteTask: (id: string) => Promise<void>;
  deleteRun: (runId: string) => Promise<void>;
  toggleTask: (id: string) => Promise<void>;
  runTaskNow: (id: string) => Promise<boolean>;
}

export const useScheduledTaskStore = create<ScheduledTaskState>((set) => ({
  tasks: [],
  runs: [],
  loading: false,
  error: null,

  async loadTasks() {
    set({ loading: true, error: null });
    try {
      const base = getDesktopBackendBase();
      const res = await fetch(`${base}/scheduled-tasks`);
      const data = (await res.json()) as { tasks: ScheduledTask[] };
      const tasks = data.tasks.map(hydrateDates);
      set({ tasks, loading: false });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : "Failed to load tasks", loading: false });
    }
  },

  async loadRuns() {
    try {
      const base = getDesktopBackendBase();
      const res = await fetch(`${base}/scheduled-tasks/runs`);
      const data = (await res.json()) as { runs: ScheduledTaskRun[] };
      const runs = data.runs.map(hydrateRunDates);
      set({ runs });
    } catch {
      // silent
    }
  },

  async createTask(data) {
    try {
      const base = getDesktopBackendBase();
      const res = await fetch(`${base}/scheduled-tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      const json = (await res.json()) as { task: ScheduledTask };
      if (!res.ok) return null;
      const task = hydrateDates(json.task);
      set((state) => ({ tasks: [task, ...state.tasks] }));
      return task;
    } catch {
      return null;
    }
  },

  async updateTask(id, data) {
    try {
      const base = getDesktopBackendBase();
      const res = await fetch(`${base}/scheduled-tasks/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (!res.ok) return null;
      const json = (await res.json()) as { task: ScheduledTask };
      const updated = hydrateDates(json.task);
      set((state) => ({
        tasks: state.tasks.map((t) => (t.id === id ? updated : t)),
      }));
      return updated;
    } catch {
      return null;
    }
  },

  async deleteTask(id) {
    try {
      const base = getDesktopBackendBase();
      await fetch(`${base}/scheduled-tasks/${id}`, { method: "DELETE" });
      set((state) => ({ tasks: state.tasks.filter((t) => t.id !== id) }));
    } catch {
      // silent
    }
  },

  async deleteRun(runId) {
    try {
      const base = getDesktopBackendBase();
      await fetch(`${base}/scheduled-tasks/runs/${runId}`, { method: "DELETE" });
      set((state) => ({ runs: state.runs.filter((r) => r.id !== runId) }));
    } catch {
      // silent
    }
  },

  async runTaskNow(id) {
    try {
      const base = getDesktopBackendBase();
      const res = await fetch(`${base}/scheduled-tasks/${id}/run`, { method: "POST" });
      return res.ok;
    } catch {
      return false;
    }
  },

  async toggleTask(id) {
    try {
      const base = getDesktopBackendBase();
      const res = await fetch(`${base}/scheduled-tasks/${id}/toggle`, { method: "PATCH" });
      const json = (await res.json()) as { task: ScheduledTask };
      const updated = hydrateDates(json.task);
      set((state) => ({
        tasks: state.tasks.map((t) => (t.id === id ? updated : t)),
      }));
    } catch {
      // silent
    }
  },
}));

function hydrateDates(raw: ScheduledTask): ScheduledTask {
  return {
    ...raw,
    createdAt: new Date(raw.createdAt),
    updatedAt: new Date(raw.updatedAt),
    lastRunAt: raw.lastRunAt ? new Date(raw.lastRunAt) : undefined,
    nextRunAt: raw.nextRunAt ? new Date(raw.nextRunAt) : undefined,
  };
}

function hydrateRunDates(raw: ScheduledTaskRun): ScheduledTaskRun {
  return {
    ...raw,
    startedAt: new Date(raw.startedAt),
    completedAt: raw.completedAt ? new Date(raw.completedAt) : undefined,
  };
}
