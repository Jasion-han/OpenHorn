import type { ScheduledTask, ScheduledTaskFrequency, ScheduledTaskRun } from "shared/types";
import { create } from "zustand";
import { getDesktopBackendBase } from "../lib/backendBase";
import { fetchWithBackendStatus } from "../lib/serverApi";

interface ScheduledTaskState {
  tasks: ScheduledTask[];
  runs: ScheduledTaskRun[];
  taskRuns: Record<string, ScheduledTaskRun[]>;
  loading: boolean;
  error: string | null;
  runsLoading: Record<string, boolean>;
  runsErrors: Record<string, string | null>;
  pendingTasks: Record<string, "toggle" | "run" | "delete" | "update">;
  pendingRuns: Record<string, boolean>;

  loadTasks: () => Promise<void>;
  /** Resolves true when the run list was actually refreshed from the server. */
  loadRuns: (taskId?: string) => Promise<boolean>;
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
  deleteTask: (id: string) => Promise<boolean>;
  deleteRun: (runId: string) => Promise<boolean>;
  toggleTask: (id: string) => Promise<boolean>;
  runTaskNow: (id: string) => Promise<string | null>;
}

export function createScheduledTaskStore(request = fetchWithBackendStatus) {
  let tasksRequest = 0;
  let runsRevision = 0;
  const runsRequests = new Map<string, number>();
  return create<ScheduledTaskState>((set, get) => {
    const reserve = (id: string, action: ScheduledTaskState["pendingTasks"][string]) => {
      if (get().pendingTasks[id]) return false;
      set((state) => ({ pendingTasks: { ...state.pendingTasks, [id]: action } }));
      return true;
    };
    const release = (id: string) =>
      set((state) => {
        const pendingTasks = { ...state.pendingTasks };
        delete pendingTasks[id];
        return { pendingTasks };
      });
    return {
      tasks: [],
      runs: [],
      taskRuns: {},
      loading: false,
      error: null,
      runsLoading: {},
      runsErrors: {},
      pendingTasks: {},
      pendingRuns: {},

      async loadTasks() {
        const epoch = ++tasksRequest;
        set({ loading: true, error: null });
        try {
          const base = getDesktopBackendBase();
          const res = await request(`${base}/scheduled-tasks`);
          if (!res.ok) throw new Error(`Failed to load tasks (${res.status})`);
          const data = (await res.json()) as { tasks: ScheduledTask[] };
          const tasks = data.tasks.map(hydrateDates);
          if (epoch === tasksRequest) set({ tasks, loading: false });
        } catch (err) {
          if (epoch === tasksRequest)
            set({
              error: err instanceof Error ? err.message : "Failed to load tasks",
              loading: false,
            });
        }
      },

      async loadRuns(taskId) {
        const key = taskId ?? "";
        const epoch = (runsRequests.get(key) ?? 0) + 1;
        runsRequests.set(key, epoch);
        const revision = runsRevision;
        const current = () => runsRequests.get(key) === epoch && revision === runsRevision;
        set((state) => ({
          runsLoading: { ...state.runsLoading, [key]: true },
          runsErrors: { ...state.runsErrors, [key]: null },
        }));
        try {
          const base = getDesktopBackendBase();
          const path = taskId ? `${encodeURIComponent(taskId)}/runs` : "runs";
          const res = await request(`${base}/scheduled-tasks/${path}`);
          if (!res.ok) throw new Error(`Failed to load runs (${res.status})`);
          const data = (await res.json()) as { runs: ScheduledTaskRun[] };
          const runs = data.runs.map(hydrateRunDates);
          if (!current()) return false;
          if (taskId) {
            set((state) => ({ taskRuns: { ...state.taskRuns, [taskId]: runs } }));
          } else {
            set({ runs });
          }
          return true;
        } catch (error) {
          if (current())
            set((state) => ({
              runsErrors: {
                ...state.runsErrors,
                [key]: error instanceof Error ? error.message : "Failed to load runs",
              },
            }));
          return false;
        } finally {
          if (runsRequests.get(key) === epoch)
            set((state) => ({ runsLoading: { ...state.runsLoading, [key]: false } }));
        }
      },

      async createTask(data) {
        try {
          const base = getDesktopBackendBase();
          const res = await request(`${base}/scheduled-tasks`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(data),
          });
          const json = (await res.json()) as { task: ScheduledTask };
          if (!res.ok) return null;
          const task = hydrateDates(json.task);
          tasksRequest++;
          set((state) => ({ tasks: [task, ...state.tasks], loading: false }));
          return task;
        } catch {
          return null;
        }
      },

      async updateTask(id, data) {
        if (!reserve(id, "update")) return null;
        try {
          const base = getDesktopBackendBase();
          const res = await request(`${base}/scheduled-tasks/${encodeURIComponent(id)}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(data),
          });
          if (!res.ok) return null;
          const json = (await res.json()) as { task: ScheduledTask };
          const updated = hydrateDates(json.task);
          tasksRequest++;
          set((state) => ({
            tasks: state.tasks.map((t) => (t.id === id ? updated : t)),
            loading: false,
          }));
          return updated;
        } catch {
          return null;
        } finally {
          release(id);
        }
      },

      async deleteTask(id) {
        if (!reserve(id, "delete")) return false;
        try {
          const base = getDesktopBackendBase();
          const res = await request(`${base}/scheduled-tasks/${encodeURIComponent(id)}`, {
            method: "DELETE",
          });
          if (!res.ok) return false;
          tasksRequest++;
          runsRevision++;
          set((state) => ({
            tasks: state.tasks.filter((t) => t.id !== id),
            loading: false,
            runs: state.runs.filter((run) => run.taskId !== id),
            taskRuns: Object.fromEntries(
              Object.entries(state.taskRuns).filter(([taskId]) => taskId !== id),
            ),
          }));
          return true;
        } catch {
          return false;
        } finally {
          release(id);
        }
      },

      async deleteRun(runId) {
        if (get().pendingRuns[runId]) return false;
        set((state) => ({ pendingRuns: { ...state.pendingRuns, [runId]: true } }));
        try {
          const base = getDesktopBackendBase();
          const res = await request(`${base}/scheduled-tasks/runs/${encodeURIComponent(runId)}`, {
            method: "DELETE",
          });
          if (!res.ok) return false;
          runsRevision++;
          set((state) => ({
            runs: state.runs.filter((r) => r.id !== runId),
            taskRuns: Object.fromEntries(
              Object.entries(state.taskRuns).map(([taskId, runs]) => [
                taskId,
                runs.filter((r) => r.id !== runId),
              ]),
            ),
          }));
          return true;
        } catch {
          return false;
        } finally {
          set((state) => {
            const pendingRuns = { ...state.pendingRuns };
            delete pendingRuns[runId];
            return { pendingRuns };
          });
        }
      },

      async runTaskNow(id) {
        if (!reserve(id, "run")) return null;
        try {
          const base = getDesktopBackendBase();
          const res = await request(`${base}/scheduled-tasks/${encodeURIComponent(id)}/run`, {
            method: "POST",
          });
          if (!res.ok) return null;
          const json = (await res.json()) as { conversationId?: string };
          return json.conversationId ?? null;
        } catch {
          return null;
        } finally {
          release(id);
        }
      },

      async toggleTask(id) {
        if (!reserve(id, "toggle")) return false;
        try {
          const base = getDesktopBackendBase();
          const res = await request(`${base}/scheduled-tasks/${encodeURIComponent(id)}/toggle`, {
            method: "PATCH",
          });
          if (!res.ok) return false;
          const json = (await res.json()) as { task: ScheduledTask };
          const updated = hydrateDates(json.task);
          tasksRequest++;
          set((state) => ({
            tasks: state.tasks.map((t) => (t.id === id ? updated : t)),
            loading: false,
          }));
          return true;
        } catch {
          return false;
        } finally {
          release(id);
        }
      },
    };
  });
}

export const useScheduledTaskStore = createScheduledTaskStore();

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
    leaseExpiresAt: raw.leaseExpiresAt ? new Date(raw.leaseExpiresAt) : undefined,
  };
}
