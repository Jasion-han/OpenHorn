"use client";

import { ChevronDown, Loader2, Play, RotateCcw, SkipForward, Wand2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { AgentArtifactsPanel } from "@/components/agent/AgentArtifactsPanel";
import { AgentExecutionPanel } from "@/components/agent/AgentExecutionPanel";
import { AgentPlanPanel } from "@/components/agent/AgentPlanPanel";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  api,
  type ApiAgentApproval,
  type ApiAgentArtifact,
  type ApiAgentRun,
  type ApiAgentTaskComplexity,
  type ApiAgentTaskDetail,
  type ApiAgentTaskEvent,
  type ApiAgentTaskUxMode,
  extractErrorMessage,
} from "@/lib/api";
import { streamAgentTaskExecution, type AgentTaskStreamEvent } from "@/lib/agent-task-stream";
import { notifyError, notifySuccess } from "@/lib/notify";
import { useChatStore } from "@/stores/chatStore";

const TASK_STATUS_LABELS = {
  draft: "草稿",
  planning: "规划中",
  awaiting_approval: "待审批",
  running: "执行中",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
} satisfies Record<NonNullable<ApiAgentRun["taskStatus"]>, string>;

const COMPLEXITY_LABELS = {
  light: "快速处理",
  standard: "简洁流程",
  deep: "完整流程",
} satisfies Record<ApiAgentTaskComplexity, string>;

function buildTaskStatusSummary(
  status: ApiAgentTaskDetail["task"]["status"],
  uxMode: ApiAgentTaskUxMode,
) {
  if (uxMode === "direct") {
    switch (status) {
      case "planning":
        return "正在准备后直接处理这项任务。";
      case "running":
        return "正在直接处理这项任务。";
      case "completed":
        return "任务已完成。";
      case "failed":
        return "任务处理失败，可以重试。";
      case "cancelled":
        return "任务已取消。";
      default:
        return "我先直接处理这项任务。";
    }
  }

  if (uxMode === "compact") {
    switch (status) {
      case "planning":
        return "正在整理简要步骤并开始执行。";
      case "running":
        return "正在按简要步骤处理这项任务。";
      case "completed":
        return "任务已完成。";
      case "failed":
        return "任务处理失败，可以重试或查看过程。";
      case "cancelled":
        return "任务已取消。";
      default:
        return "我会按简要步骤直接开始处理。";
    }
  }

  switch (status) {
    case "planning":
      return "正在整理执行路径并开始执行。";
    case "awaiting_approval":
      return "任务暂时停下，等待进一步批准。";
    case "running":
      return "任务正在执行。";
    case "completed":
      return "任务已完成。";
    case "failed":
      return "任务执行失败，可继续、重试或重新规划。";
    case "cancelled":
      return "任务已取消。";
    default:
      return "我会先展开任务并开始执行。";
  }
}

function buildTaskBackedAgentRun(detail: ApiAgentTaskDetail): ApiAgentRun {
  const latestRun = detail.runs[0] ?? null;
  const latestApproval = detail.approvals[0] ?? null;

  return {
    status:
      detail.task.status === "awaiting_approval"
        ? "awaiting_approval"
        : detail.task.status === "running"
          ? "running"
          : detail.task.status === "failed"
            ? "failed"
            : detail.task.status === "cancelled"
              ? "cancelled"
              : "completed",
    summary: buildTaskMessageSummary(detail),
    steps: [],
    taskId: detail.task.id,
    complexity: detail.task.complexity,
    uxMode: detail.task.uxMode,
    requiresPlanApproval: detail.task.requiresPlanApproval,
    autoStart: detail.task.autoStart,
    taskStatus: detail.task.status,
    latestRunId: latestRun?.id ?? null,
    latestRunPhase: latestRun?.phase ?? null,
    latestApprovalId: latestApproval?.id ?? null,
    latestApprovalType: latestApproval?.type ?? null,
    latestApprovalStatus: latestApproval?.status ?? null,
  };
}

function buildTaskMessageSummary(detail: ApiAgentTaskDetail) {
  const finalResult =
    detail.artifacts.find((artifact) => artifact.type === "final_result")?.content.trim() ?? "";
  const statusSummary = buildTaskStatusSummary(detail.task.status, detail.task.uxMode);
  if (detail.task.status === "completed" && finalResult) {
    return finalResult;
  }

  const preview = detail.task.insight?.previewText?.trim() || "";
  const completedSummary = detail.task.insight?.summary?.trim() || "";
  if (detail.task.status === "completed") {
    return preview || completedSummary || statusSummary;
  }

  return preview || statusSummary;
}

function getPendingApproval(detail: ApiAgentTaskDetail): ApiAgentApproval | null {
  return detail.approvals.find((approval) => approval.status === "pending") ?? null;
}

function getPlanStepsForDetail(detail: ApiAgentTaskDetail, approval: ApiAgentApproval | null) {
  const planningRunId =
    approval?.type === "plan_approval"
      ? approval.runId
      : detail.runs.find((run) => run.phase === "planning")?.id ?? null;

  if (!planningRunId) return [];
  return detail.planSteps
    .filter((step) => step.runId === planningRunId)
    .sort((left, right) => left.orderIndex - right.orderIndex);
}

function getLatestExecutionRun(detail: ApiAgentTaskDetail) {
  return detail.runs.find((run) => run.phase === "execution") ?? null;
}

function getRunEvents(detail: ApiAgentTaskDetail, runId: string | null): ApiAgentTaskEvent[] {
  if (!runId) return [];
  return detail.events.filter((event) => event.runId === runId);
}

function getRunArtifacts(detail: ApiAgentTaskDetail, runId: string | null): ApiAgentArtifact[] {
  if (!runId) return [];
  return detail.artifacts.filter((artifact) => artifact.runId === runId);
}

function mergeExecutionEvent(detail: ApiAgentTaskDetail, nextEvent: ApiAgentTaskEvent) {
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

function toLiveEvent(taskId: string, event: AgentTaskStreamEvent): ApiAgentTaskEvent | null {
  if (event.type !== "execution_event" && event.type !== "error") {
    return null;
  }

  return {
    id: `chat-live-${Date.now()}-${Math.random()}`,
    taskId,
    runId: event.runId ?? "live-run",
    type: event.type === "error" ? "error" : "execution_event",
    content: event.content ?? null,
    toolName: "toolName" in event ? event.toolName ?? null : null,
    toolInput: "toolInput" in event ? event.toolInput ?? null : null,
    metadata: { eventType: "eventType" in event ? event.eventType ?? "text" : "error", live: true },
    createdAt: new Date().toISOString(),
  };
}

export function ChatAgentTaskCard({
  messageId,
  taskId,
}: {
  messageId: string;
  taskId: string;
}) {
  const [detail, setDetail] = useState<ApiAgentTaskDetail | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [busyAction, setBusyAction] = useState<
    "approve" | "reject" | "execute" | "retry" | "continue" | "replan" | "cancel" | null
  >(null);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const autoExecuteKeyRef = useRef<string | null>(null);

  const syncMessage = (nextDetail: ApiAgentTaskDetail) => {
    useChatStore
      .getState()
      .updateMessage(messageId, buildTaskMessageSummary(nextDetail), {
        agentRun: buildTaskBackedAgentRun(nextDetail),
      });
  };

  const loadDetail = async (silent = false) => {
    if (!silent) {
      setIsLoading(true);
    }
    try {
      const nextDetail = await api.agentTasks.get(taskId);
      setDetail(nextDetail);
      syncMessage(nextDetail);
      return nextDetail;
    } catch (error) {
      if (!silent) {
        notifyError("加载任务失败", error instanceof Error ? error.message : "无法加载 Agent 任务");
      }
      return null;
    } finally {
      if (!silent) {
        setIsLoading(false);
      }
    }
  };

  useEffect(() => {
    void loadDetail();
  }, [taskId]);

  useEffect(() => {
    if (!detail || (detail.task.status !== "running" && detail.task.status !== "awaiting_approval")) {
      return;
    }

    const timer = window.setInterval(() => {
      void loadDetail(true);
    }, 4000);

    return () => {
      window.clearInterval(timer);
    };
  }, [detail?.task.status, taskId]);

  const approval = useMemo(() => (detail ? getPendingApproval(detail) : null), [detail]);
  const effectiveUxMode = useMemo<ApiAgentTaskUxMode>(() => {
    if (!detail) return "full";
    if (approval?.status === "pending") {
      return "full";
    }
    return detail.task.uxMode;
  }, [detail, approval]);
  const planSteps = useMemo(
    () => (detail ? getPlanStepsForDetail(detail, approval) : []),
    [detail, approval],
  );
  const executionRun = useMemo(() => (detail ? getLatestExecutionRun(detail) : null), [detail]);
  const executionEvents = useMemo(
    () => (detail ? getRunEvents(detail, executionRun?.id ?? null) : []),
    [detail, executionRun],
  );
  const executionArtifacts = useMemo(
    () => (detail ? getRunArtifacts(detail, executionRun?.id ?? null) : []),
    [detail, executionRun],
  );
  const inlineSummary = useMemo(() => {
    if (!detail) return "";
    return buildTaskStatusSummary(detail.task.status, effectiveUxMode);
  }, [detail, effectiveUxMode]);

  useEffect(() => {
    if (!detail) return;
    if (
      effectiveUxMode === "full" ||
      detail.task.status === "planning" ||
      detail.task.status === "running" ||
      detail.task.status === "failed" ||
      detail.task.status === "awaiting_approval"
    ) {
      setExpanded(true);
    }
  }, [detail, effectiveUxMode]);

  useEffect(() => {
    if (!detail || !detail.task.autoStart || detail.task.status !== "draft") {
      return;
    }

    const key = `${detail.task.id}:${detail.task.updatedAt}:${detail.task.status}`;
    if (autoExecuteKeyRef.current === key || busyAction !== null) {
      return;
    }
    autoExecuteKeyRef.current = key;

    void runExecutionAction("execute", () => api.agentTasks.execute(detail.task.id));
  }, [detail, busyAction]);

  const runExecutionAction = async (
    action: "execute" | "retry" | "continue",
    responseFactory: () => Promise<Response>,
  ) => {
    if (!detail) return;
    setBusyAction(action);
    setExpanded(true);
    setStreamError(null);

    try {
      await streamAgentTaskExecution(
        detail.task.id,
        {
          onEvent: async (event) => {
            if (event.type === "task_status") {
              setDetail((current) =>
                current
                  ? {
                      ...current,
                      task: { ...current.task, status: event.status },
                    }
                  : current,
              );
              if (event.status === "awaiting_approval" || event.status === "completed" || event.status === "failed") {
                const refreshed = await loadDetail(true);
                if (refreshed) {
                  setDetail(refreshed);
                }
              }
              return;
            }

            if (event.type === "plan_step") {
              setDetail((current) =>
                current
                  ? {
                      ...current,
                      planSteps: current.planSteps.map((step) =>
                        step.id === event.stepId ? { ...step, status: event.status } : step,
                      ),
                    }
                  : current,
              );
              return;
            }

            if (event.type === "final_result") {
              setDetail((current) => {
                if (!current) return current;
                const artifact: ApiAgentArtifact = {
                  id: `chat-live-final-${event.runId}`,
                  taskId: current.task.id,
                  runId: event.runId,
                  type: "final_result",
                  title: "Final result",
                  content: event.content,
                  metadata: { live: true },
                  createdAt: new Date().toISOString(),
                  updatedAt: new Date().toISOString(),
                };
                return {
                  ...current,
                  artifacts: [artifact, ...current.artifacts.filter((item) => item.id !== artifact.id)],
                };
              });
              return;
            }

            const liveEvent = toLiveEvent(detail.task.id, event);
            if (liveEvent) {
              setDetail((current) => (current ? mergeExecutionEvent(current, liveEvent) : current));
              return;
            }

            if (event.type === "done") {
              await loadDetail(true);
            }
          },
          onError: (message) => {
            setStreamError(extractErrorMessage(message, "任务执行失败"));
          },
        },
        {
          response: await responseFactory(),
        },
      );

      const refreshed = await loadDetail(true);
      if (refreshed) {
        setDetail(refreshed);
      }
    } catch (error) {
      const message = extractErrorMessage(error, "任务执行失败");
      setStreamError(message);
      notifyError("任务执行失败", message);
      const refreshed = await loadDetail(true);
      if (refreshed) {
        setDetail(refreshed);
      }
    } finally {
      setBusyAction(null);
    }
  };

  const handleApproval = async (status: "approved" | "rejected") => {
    if (!approval) return;
    setBusyAction(status === "approved" ? "approve" : "reject");
    try {
      const nextDetail = await api.agentTasks.respondApproval(approval.id, { status });
      setDetail(nextDetail);
      syncMessage(nextDetail);
      notifySuccess(status === "approved" ? "已批准" : "已拒绝", "审批状态已更新。");
    } catch (error) {
      notifyError("审批失败", error instanceof Error ? error.message : "无法更新审批状态");
    } finally {
      setBusyAction(null);
    }
  };

  const handleReplan = async () => {
    if (!detail) return;
    setBusyAction("replan");
    try {
      const nextDetail = await api.agentTasks.plan(detail.task.id);
      setDetail(nextDetail);
      syncMessage(nextDetail);
      setExpanded(true);
      notifySuccess("已重新规划", "任务计划已重新生成。");
    } catch (error) {
      notifyError("重新规划失败", error instanceof Error ? error.message : "无法重新规划任务");
    } finally {
      setBusyAction(null);
    }
  };

  const handleCancel = async () => {
    if (!detail) return;
    setBusyAction("cancel");
    try {
      const nextDetail = await api.agentTasks.cancel(detail.task.id);
      setDetail(nextDetail);
      syncMessage(nextDetail);
      notifySuccess("已取消", "任务已标记为取消。");
    } catch (error) {
      notifyError("取消失败", error instanceof Error ? error.message : "无法取消任务");
    } finally {
      setBusyAction(null);
    }
  };

  if (isLoading && !detail) {
    return (
      <div className="mt-2 rounded-2xl border border-border/60 bg-muted/20 px-4 py-3 text-sm text-muted-foreground">
        正在加载 Agent 任务...
      </div>
    );
  }

  if (!detail) {
    return null;
  }

  const canExecute = detail.task.status === "draft";
  const canRetry = detail.task.status === "failed" || detail.task.status === "completed" || detail.task.status === "cancelled";
  const canContinue = detail.task.status === "failed" || detail.task.status === "completed";
  const canCancel = detail.task.status === "running";
  const showFullPanels = effectiveUxMode === "full";
  const showCompactPlan = effectiveUxMode === "compact" && planSteps.length > 0;
  const visibleCompactSteps = planSteps.slice(0, 3);
  const showInlineError = effectiveUxMode !== "full" && Boolean(streamError);

  return (
    <section className="mt-2 overflow-hidden rounded-2xl border border-border/60 bg-muted/20">
      <button
        type="button"
        onClick={() => setExpanded((current) => !current)}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
      >
        <div className="min-w-0">
          <div className="text-sm font-medium">Agent 任务</div>
          <p className="mt-1 text-xs text-muted-foreground">
            {TASK_STATUS_LABELS[detail.task.status]} · {detail.task.title}
          </p>
          {effectiveUxMode !== "full" ? (
            <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{inlineSummary}</p>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          {busyAction ? <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /> : null}
          <span className="rounded-full border border-border/60 bg-background/70 px-2 py-0.5 text-[11px] text-muted-foreground">
            {COMPLEXITY_LABELS[detail.task.complexity]}
          </span>
          <span className="rounded-full border border-border/60 bg-background/70 px-2 py-0.5 text-[11px] text-muted-foreground">
            {TASK_STATUS_LABELS[detail.task.status]}
          </span>
          <ChevronDown className={cn("h-4 w-4 text-muted-foreground transition-transform", expanded && "rotate-180")} />
        </div>
      </button>

      {expanded ? (
        <div className="space-y-3 border-t border-border/50 px-3 py-3">
          {effectiveUxMode !== "full" ? (
            <section className="rounded-2xl border border-border/60 bg-background/75 px-4 py-3">
              <p className="text-sm leading-6 text-foreground/90">{inlineSummary}</p>
              {showCompactPlan ? (
                <div className="mt-3 space-y-2">
                  {visibleCompactSteps.map((step) => (
                    <div key={step.id} className="text-sm text-muted-foreground">
                      {step.orderIndex + 1}. {step.title}
                    </div>
                  ))}
                </div>
              ) : null}
              {showInlineError && streamError ? (
                <div className="mt-3 rounded-xl border border-destructive/20 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                  {streamError}
                </div>
              ) : null}
            </section>
          ) : null}

          <div className="flex flex-wrap gap-2">
            {canExecute ? (
              <Button
                size="sm"
                onClick={() =>
                  void runExecutionAction("execute", () => api.agentTasks.execute(detail.task.id))
                }
                disabled={busyAction !== null}
              >
                <Play className="mr-1 h-3.5 w-3.5" />
                开始执行
              </Button>
            ) : null}
            {canContinue ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  void runExecutionAction("continue", () => api.agentTasks.continue(detail.task.id))
                }
                disabled={busyAction !== null}
              >
                <SkipForward className="mr-1 h-3.5 w-3.5" />
                继续
              </Button>
            ) : null}
            {canRetry ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  void runExecutionAction("retry", () => api.agentTasks.retry(detail.task.id))
                }
                disabled={busyAction !== null}
              >
                <RotateCcw className="mr-1 h-3.5 w-3.5" />
                重试
              </Button>
            ) : null}
            <Button size="sm" variant="outline" onClick={() => void handleReplan()} disabled={busyAction !== null}>
              <Wand2 className="mr-1 h-3.5 w-3.5" />
              重新规划
            </Button>
            {canCancel ? (
              <Button size="sm" variant="outline" onClick={() => void handleCancel()} disabled={busyAction !== null}>
                取消
              </Button>
            ) : null}
          </div>

          {showFullPanels ? (
            <AgentPlanPanel
              planSteps={planSteps}
              approval={approval}
              onApprove={() => void handleApproval("approved")}
              onReject={() => void handleApproval("rejected")}
            />
          ) : approval ? (
            <div className="rounded-2xl border border-border/60 bg-background/75 px-4 py-3">
              <div className="mb-3 text-sm font-medium">{approval.title}</div>
              {approval.description ? (
                <p className="mb-3 text-sm text-muted-foreground">{approval.description}</p>
              ) : null}
              <div className="flex flex-wrap gap-2">
                <Button size="sm" onClick={() => void handleApproval("approved")} disabled={busyAction !== null}>
                  批准
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void handleApproval("rejected")}
                  disabled={busyAction !== null}
                >
                  拒绝
                </Button>
              </div>
            </div>
          ) : null}

          {showFullPanels ? (
            <AgentExecutionPanel
              events={executionEvents}
              streamError={streamError}
              runLabel={executionRun ? `执行 #${executionRun.id.slice(0, 6)}` : null}
            />
          ) : null}

          {showFullPanels ? <AgentArtifactsPanel artifacts={executionArtifacts} /> : null}
        </div>
      ) : null}
    </section>
  );
}
