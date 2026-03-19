"use client";

import { create } from "zustand";
import { streamAgentTaskExecution, type AgentTaskStreamEvent } from "@/lib/agent-task-stream";
import {
  api,
  type ApiAgentArtifact,
  type ApiAgentTask,
  type ApiAgentTaskDetail,
  type ApiAgentTaskEvent,
} from "@/lib/api";
import { notifyError, notifySuccess } from "@/lib/notify";

function sortTasks(tasks: ApiAgentTask[]) {
  return [...tasks].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

function upsertTask(tasks: ApiAgentTask[], task: ApiAgentTask) {
  const rest = tasks.filter((item) => item.id !== task.id);
  return sortTasks([task, ...rest]);
}

function toLiveEvent(
  event: AgentTaskStreamEvent,
  taskId: string,
  runId: string,
): ApiAgentTaskEvent | null {
  if (event.type === "execution_event") {
    return {
      id: `live-${Date.now()}-${Math.random()}`,
      taskId,
      runId,
      type: "execution_event",
      content: event.content ?? null,
      toolName: event.toolName ?? null,
      toolInput: event.toolInput ?? null,
      metadata: { eventType: event.eventType ?? "text", live: true },
      createdAt: new Date().toISOString(),
    };
  }

  if (event.type === "error") {
    return {
      id: `live-${Date.now()}-${Math.random()}`,
      taskId,
      runId,
      type: "error",
      content: event.content,
      toolName: null,
      toolInput: null,
      metadata: { live: true },
      createdAt: new Date().toISOString(),
    };
  }

  return null;
}

function mergeLiveEvent(detail: ApiAgentTaskDetail, nextEvent: ApiAgentTaskEvent) {
  const events = [...detail.events];
  const last = events[events.length - 1];
  const lastEventType =
    last && typeof last.metadata === "object" && last.metadata
      ? (last.metadata as Record<string, unknown>).eventType
      : null;
  const nextEventType =
    typeof nextEvent.metadata === "object" && nextEvent.metadata
      ? (nextEvent.metadata as Record<string, unknown>).eventType
      : null;

  if (
    nextEvent.type === "execution_event" &&
    nextEventType === "text" &&
    last?.type === "execution_event" &&
    lastEventType === "text"
  ) {
    events[events.length - 1] = {
      ...last,
      content: `${last.content ?? ""}${nextEvent.content ?? ""}`,
      createdAt: nextEvent.createdAt,
    };
    return { ...detail, events };
  }

  events.push(nextEvent);
  return { ...detail, events };
}

function upsertArtifact(artifacts: ApiAgentArtifact[], artifact: ApiAgentArtifact) {
  const rest = artifacts.filter((item) => item.id !== artifact.id);
  return [artifact, ...rest].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

function mergeLivePlanStep(
  detail: ApiAgentTaskDetail,
  nextStep: Extract<AgentTaskStreamEvent, { type: "plan_step" }>,
) {
  return {
    ...detail,
    planSteps: detail.planSteps.map((step) =>
      step.id === nextStep.stepId ? { ...step, status: nextStep.status } : step,
    ),
  };
}

type AgentTaskSetState = (
  partial:
    | Partial<AgentTaskState>
    | ((state: AgentTaskState) => Partial<AgentTaskState>),
) => void;

type AgentTaskGetState = () => AgentTaskState;

async function runTaskExecutionStream(params: {
  taskId: string;
  set: AgentTaskSetState;
  get: AgentTaskGetState;
  responseFactory: (signal?: AbortSignal) => Promise<Response>;
  failureTitle: string;
}) {
  const detail = params.get().detail;
  if (!detail || detail.task.id !== params.taskId) return;

  params.set({ isExecuting: true, streamError: null });

  try {
    await streamAgentTaskExecution(
      detail.task.id,
      {
        onEvent: async (event) => {
          const current = params.get().detail;
          if (!current || current.task.id !== detail.task.id) return;

          if (event.type === "task_status") {
            params.set((state) => ({
              detail: state.detail
                ? {
                    ...state.detail,
                    task: { ...state.detail.task, status: event.status },
                  }
                : state.detail,
              tasks: state.detail
                ? upsertTask(state.tasks, { ...state.detail.task, status: event.status })
                : state.tasks,
            }));
            return;
          }

          if (event.type === "final_result") {
            const artifact: ApiAgentArtifact = {
              id: `live-final-${event.runId}`,
              taskId: detail.task.id,
              runId: event.runId,
              type: "final_result",
              title: "Final result",
              content: event.content,
              metadata: { live: true },
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            };
            params.set((state) =>
              state.detail
                ? {
                    detail: {
                      ...state.detail,
                      artifacts: upsertArtifact(state.detail.artifacts, artifact),
                    },
                  }
                : state,
            );
            return;
          }

          if (event.type === "plan_step") {
            params.set((state) =>
              state.detail
                ? {
                    detail: mergeLivePlanStep(state.detail, event),
                  }
                : state,
            );
            return;
          }

          const runId = "runId" in event && typeof event.runId === "string" ? event.runId : null;
          const liveEvent = runId ? toLiveEvent(event, detail.task.id, runId) : null;
          if (liveEvent) {
            params.set((state) =>
              state.detail
                ? {
                    detail: mergeLiveEvent(state.detail, liveEvent),
                  }
                : state,
            );
            return;
          }

          if (event.type === "done") {
            await params.get().refreshTask(detail.task.id, { silent: true });
          }
        },
        onError: (message) => {
          params.set({ streamError: message });
        },
      },
      {
        response: await params.responseFactory(),
      },
    );

    await params.get().refreshTask(detail.task.id, { silent: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : params.failureTitle;
    params.set({ streamError: message });
    notifyError(params.failureTitle, message);
  } finally {
    params.set({ isExecuting: false });
  }
}

interface AgentTaskState {
  tasks: ApiAgentTask[];
  selectedTaskId: string | null;
  detail: ApiAgentTaskDetail | null;
  isLoading: boolean;
  isRefreshingDetail: boolean;
  isCreating: boolean;
  isPlanning: boolean;
  isExecuting: boolean;
  isSavingGoal: boolean;
  streamError: string | null;
  draftTitle: string;
  draftGoal: string;
  loadTasks: () => Promise<void>;
  selectTask: (taskId: string | null) => Promise<void>;
  refreshTask: (taskId?: string | null, options?: { silent?: boolean }) => Promise<void>;
  setDraftTitle: (value: string) => void;
  setDraftGoal: (value: string) => void;
  createTask: () => Promise<void>;
  requestPlan: () => Promise<void>;
  respondApproval: (
    approvalId: string,
    status: "approved" | "rejected",
    response?: unknown,
  ) => Promise<void>;
  executeTask: () => Promise<void>;
  retryTask: () => Promise<void>;
  continueTask: () => Promise<void>;
  replanTask: () => Promise<void>;
  saveTaskGoal: (goal: string) => Promise<boolean>;
  cancelTask: () => Promise<void>;
}

export const useAgentTaskStore = create<AgentTaskState>((set, get) => ({
  tasks: [],
  selectedTaskId: null,
  detail: null,
  isLoading: false,
  isRefreshingDetail: false,
  isCreating: false,
  isPlanning: false,
  isExecuting: false,
  isSavingGoal: false,
  streamError: null,
  draftTitle: "",
  draftGoal: "",

  loadTasks: async () => {
    set({ isLoading: true });
    try {
      const { tasks } = await api.agentTasks.list();
      const sorted = sortTasks(tasks);
      const selectedTaskId = get().selectedTaskId ?? sorted[0]?.id ?? null;
      set({ tasks: sorted, selectedTaskId });
      if (selectedTaskId) {
        await get().refreshTask(selectedTaskId, { silent: true });
      } else {
        set({ detail: null, isExecuting: false, streamError: null });
      }
    } catch (error) {
      notifyError("加载失败", error instanceof Error ? error.message : "无法加载任务");
    } finally {
      set({ isLoading: false });
    }
  },

  selectTask: async (taskId) => {
    set({ selectedTaskId: taskId });
    if (taskId) {
      await get().refreshTask(taskId);
    } else {
      set({ detail: null, isExecuting: false, streamError: null });
    }
  },

  refreshTask: async (taskId, options) => {
    const nextTaskId = taskId ?? get().selectedTaskId;
    if (!nextTaskId) return;
    if (!options?.silent) {
      set({ isRefreshingDetail: true });
    }
    try {
      const detail = await api.agentTasks.get(nextTaskId);
      set((state) => ({
        detail,
        tasks: upsertTask(state.tasks, detail.task),
        isExecuting: detail.task.status === "running",
        streamError: detail.task.status === "running" ? state.streamError : null,
      }));
    } catch (error) {
      if (!options?.silent) {
        notifyError("加载失败", error instanceof Error ? error.message : "无法加载任务详情");
      }
    } finally {
      if (!options?.silent) {
        set({ isRefreshingDetail: false });
      }
    }
  },

  setDraftTitle: (value) => set({ draftTitle: value }),
  setDraftGoal: (value) => set({ draftGoal: value }),

  createTask: async () => {
    const { draftGoal, draftTitle } = get();
    if (!draftGoal.trim()) {
      notifyError("目标为空", "请先填写任务目标。");
      return;
    }

    set({ isCreating: true });
    try {
      const { task } = await api.agentTasks.create({
        title: draftTitle.trim() || undefined,
        goal: draftGoal,
      });
      set((state) => ({
        tasks: upsertTask(state.tasks, task),
        selectedTaskId: task.id,
        draftTitle: "",
        draftGoal: "",
      }));
      await get().refreshTask(task.id);
      notifySuccess("已创建", "任务已创建。");
    } catch (error) {
      notifyError("创建失败", error instanceof Error ? error.message : "无法创建任务");
    } finally {
      set({ isCreating: false });
    }
  },

  requestPlan: async () => {
    const taskId = get().selectedTaskId;
    if (!taskId) return;
    set({ isPlanning: true });
    try {
      const detail = await api.agentTasks.plan(taskId);
      set((state) => ({
        detail,
        tasks: upsertTask(state.tasks, detail.task),
        isExecuting: false,
      }));
      notifySuccess("规划完成", "任务计划已生成。");
    } catch (error) {
      notifyError("规划失败", error instanceof Error ? error.message : "无法生成计划");
    } finally {
      set({ isPlanning: false });
    }
  },

  respondApproval: async (approvalId, status, response) => {
    try {
      const detail = await api.agentTasks.respondApproval(approvalId, {
        status,
        response,
      });
      set((state) => ({
        detail,
        tasks: upsertTask(state.tasks, detail.task),
        isExecuting: detail.task.status === "running",
      }));
      notifySuccess(status === "approved" ? "已批准" : "已拒绝", "审批状态已更新。");
    } catch (error) {
      notifyError("审批失败", error instanceof Error ? error.message : "无法更新审批状态");
    }
  },

  executeTask: async () => {
    const detail = get().detail;
    if (!detail) return;
    await runTaskExecutionStream({
      taskId: detail.task.id,
      set,
      get,
      responseFactory: (signal) => api.agentTasks.execute(detail.task.id, { signal }),
      failureTitle: "执行失败",
    });
  },

  retryTask: async () => {
    const detail = get().detail;
    if (!detail) return;
    await runTaskExecutionStream({
      taskId: detail.task.id,
      set,
      get,
      responseFactory: (signal) => api.agentTasks.retry(detail.task.id, { signal }),
      failureTitle: "重试失败",
    });
  },

  continueTask: async () => {
    const detail = get().detail;
    if (!detail) return;
    await runTaskExecutionStream({
      taskId: detail.task.id,
      set,
      get,
      responseFactory: (signal) => api.agentTasks.continue(detail.task.id, { signal }),
      failureTitle: "继续失败",
    });
  },

  replanTask: async () => {
    const taskId = get().selectedTaskId;
    if (!taskId) return;
    set({ isPlanning: true, isExecuting: false, streamError: null });
    try {
      const detail = await api.agentTasks.plan(taskId);
      set((state) => ({
        detail,
        tasks: upsertTask(state.tasks, detail.task),
      }));
      notifySuccess("已重新规划", "任务计划已根据当前目标重新生成。");
    } catch (error) {
      notifyError("重新规划失败", error instanceof Error ? error.message : "无法重新生成计划");
    } finally {
      set({ isPlanning: false });
    }
  },

  saveTaskGoal: async (goal) => {
    const detail = get().detail;
    if (!detail) return false;

    if (!goal.trim()) {
      notifyError("目标为空", "请先填写任务目标。");
      return false;
    }

    set({ isSavingGoal: true, isExecuting: false, streamError: null });
    try {
      const nextDetail = await api.agentTasks.update(detail.task.id, { goal });
      set((state) => ({
        detail: nextDetail,
        tasks: upsertTask(state.tasks, nextDetail.task),
      }));
      notifySuccess("已更新目标", "任务目标已保存，旧计划已失效，请重新规划。");
      return true;
    } catch (error) {
      notifyError("保存失败", error instanceof Error ? error.message : "无法更新任务目标");
      return false;
    } finally {
      set({ isSavingGoal: false });
    }
  },

  cancelTask: async () => {
    const taskId = get().selectedTaskId;
    if (!taskId) return;
    try {
      const detail = await api.agentTasks.cancel(taskId);
      set((state) => ({
        detail,
        tasks: upsertTask(state.tasks, detail.task),
        isExecuting: false,
        streamError: null,
      }));
      notifySuccess("已取消", "任务已标记为取消。");
    } catch (error) {
      notifyError("取消失败", error instanceof Error ? error.message : "无法取消任务");
    }
  },
}));
