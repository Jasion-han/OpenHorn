import {
  AlertCircle,
  ChevronDown,
  FileText,
  Loader2,
  PackageOpen,
  Play,
  RotateCcw,
  SkipForward,
  Sparkles,
  Wand2,
  Wrench,
  XCircle,
} from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { Button, cn } from "ui";
import { streamAgentTaskExecution, type AgentTaskStreamEvent } from "../../lib/agentTaskStream";
import { sanitizeDisplayContent } from "../../lib/citations";
import { readErrorMessage, createServerApi } from "../../lib/serverApi";
import { useChatStore } from "../../stores/chatStore";
import type {
  ApiAgentApproval,
  ApiAgentArtifact,
  ApiAgentRun,
  ApiAgentTaskDetail,
  ApiAgentTaskEvent,
  ApiAgentTaskUxMode,
  ApiCitation,
} from "../../types/chat";
import { DesktopCitationList } from "./DesktopCitationList";
import { DesktopMarkdownMessage } from "./DesktopMarkdownMessage";

const api = createServerApi();

function extractErrorMessage(error: unknown, fallback = "任务执行失败") {
  if (typeof error === "string") return error.trim() || fallback;
  if (error instanceof Error) return error.message.trim() || fallback;
  return fallback;
}

function getArtifactCitations(artifact: ApiAgentArtifact | null | undefined): ApiCitation[] | undefined {
  if (!artifact || typeof artifact.metadata !== "object" || !artifact.metadata) return undefined;
  const metadata = artifact.metadata as Record<string, unknown>;
  const citations = metadata.citations;
  return Array.isArray(citations) ? (citations as ApiCitation[]) : undefined;
}

function getTaskFinalResultArtifact(detail: ApiAgentTaskDetail) {
  return detail.artifacts.find((artifact) => artifact.type === "final_result") ?? null;
}

function getTaskFinalResultCitations(detail: ApiAgentTaskDetail) {
  return getArtifactCitations(getTaskFinalResultArtifact(detail));
}

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
        return "我会先直接处理这项任务。";
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

function buildTaskMessageSummary(detail: ApiAgentTaskDetail) {
  const finalResultCitations = getTaskFinalResultCitations(detail);
  const finalResult = sanitizeDisplayContent(
    getTaskFinalResultArtifact(detail)?.content ?? "",
    finalResultCitations,
  ).trim();
  const statusSummary = buildTaskStatusSummary(detail.task.status, detail.task.uxMode);
  if (detail.task.status === "completed" && finalResult) {
    return finalResult;
  }

  const preview = sanitizeDisplayContent(
    detail.task.insight?.previewText ?? "",
    finalResultCitations,
  ).trim();
  const completedSummary = sanitizeDisplayContent(
    detail.task.insight?.summary ?? "",
    finalResultCitations,
  ).trim();
  if (detail.task.status === "completed") {
    return preview || completedSummary || statusSummary;
  }

  return preview || statusSummary;
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

function getPendingApproval(detail: ApiAgentTaskDetail) {
  return detail.approvals.find((approval) => approval.status === "pending") ?? null;
}

function getPlanStepsForDetail(detail: ApiAgentTaskDetail, approval: ApiAgentApproval | null) {
  const planningRunId =
    approval?.type === "plan_approval"
      ? approval.runId
      : (detail.runs.find((run) => run.phase === "planning")?.id ?? null);

  if (!planningRunId) return [];
  return detail.planSteps
    .filter((step) => step.runId === planningRunId)
    .sort((left, right) => left.orderIndex - right.orderIndex);
}

function getLatestExecutionRun(detail: ApiAgentTaskDetail) {
  return detail.runs.find((run) => run.phase === "execution") ?? null;
}

function getRunEvents(detail: ApiAgentTaskDetail, runId: string | null) {
  if (!runId) return [];
  return detail.events.filter((event) => event.runId === runId);
}

function getRunArtifacts(detail: ApiAgentTaskDetail, runId: string | null) {
  if (!runId) return [];
  return detail.artifacts.filter((artifact) => artifact.runId === runId);
}

function getExecutionEventType(event: ApiAgentTaskEvent) {
  return typeof event.metadata === "object" && event.metadata
    ? (event.metadata as Record<string, unknown>).eventType
    : null;
}

function summarizeToolInput(toolInput: ApiAgentTaskEvent["toolInput"]) {
  if (!toolInput || typeof toolInput !== "object") return null;
  const input = toolInput as Record<string, unknown>;

  const query =
    typeof input.query === "string"
      ? input.query
      : typeof input.q === "string"
        ? input.q
        : typeof input.search_query === "string"
          ? input.search_query
          : null;
  if (query) return query.length > 64 ? `${query.slice(0, 61)}...` : query;

  const url = typeof input.url === "string" ? input.url : null;
  if (url) return url.length > 72 ? `${url.slice(0, 69)}...` : url;

  const path =
    typeof input.path === "string"
      ? input.path
      : typeof input.file_path === "string"
        ? input.file_path
        : null;
  if (path) return path;

  const command =
    typeof input.command === "string"
      ? input.command
      : typeof input.cmd === "string"
        ? input.cmd
        : null;
  if (command) return command.length > 72 ? `${command.slice(0, 69)}...` : command;

  return null;
}

function summarizeExecutionEvent(event: ApiAgentTaskEvent) {
  const eventType = getExecutionEventType(event);
  const normalized = (event.content ?? "").trim().replace(/\s+/g, " ");
  if (event.type === "error") {
    return normalized || "本轮动作中断。";
  }

  if (eventType === "tool_start") {
    return summarizeToolInput(event.toolInput) || "正在执行本轮动作。";
  }

  if (eventType === "tool_result") {
    return normalized || "已完成本轮工具操作。";
  }

  return normalized || null;
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
  if (event.type !== "execution_event" && event.type !== "error") return null;

  return {
    id: `desktop-live-${Date.now()}-${Math.random()}`,
    taskId,
    runId: event.runId ?? "live-run",
    type: event.type === "error" ? "error" : "execution_event",
    content: event.content ?? null,
    toolName: "toolName" in event ? (event.toolName ?? null) : null,
    toolInput: "toolInput" in event ? (event.toolInput ?? null) : null,
    metadata: {
      eventType: "eventType" in event ? (event.eventType ?? "text") : "error",
      live: true,
    },
    createdAt: new Date().toISOString(),
  };
}

function MetaPill({
  label,
  tone = "default",
}: {
  label: string;
  tone?: "default" | "accent" | "danger";
}) {
  return (
    <span
      className={cn(
        "rounded-full border px-2 py-0.5 text-[11px]",
        tone === "accent"
          ? "border-emerald-300/60 bg-emerald-50 text-emerald-700"
          : tone === "danger"
            ? "border-destructive/20 bg-destructive/5 text-destructive"
            : "border-border/60 bg-background/70 text-muted-foreground",
      )}
    >
      {label}
    </span>
  );
}

function Section({
  title,
  meta,
  icon,
  children,
  defaultOpen = false,
}: {
  title: string;
  meta?: string | null;
  icon: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);

  useEffect(() => {
    setOpen(defaultOpen);
  }, [defaultOpen]);

  return (
    <section className="overflow-hidden rounded-xl border border-border/45 bg-background/55">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left transition-colors hover:bg-background/60"
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-[12px] font-medium text-foreground/85">
            {icon}
            <span>{title}</span>
          </div>
          {meta ? <p className="mt-1 text-[11px] leading-5 text-muted-foreground">{meta}</p> : null}
        </div>
        <ChevronDown className={cn("h-4 w-4 text-muted-foreground transition-transform", open && "rotate-180")} />
      </button>
      {open ? <div className="border-t border-border/40 px-3 py-2.5">{children}</div> : null}
    </section>
  );
}

export function DesktopAgentTaskCard({ messageId, taskId }: { messageId: string; taskId: string }) {
  const [detail, setDetail] = useState<ApiAgentTaskDetail | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [busyAction, setBusyAction] = useState<
    "approve" | "reject" | "execute" | "retry" | "continue" | "replan" | "cancel" | null
  >(null);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const autoExecuteKeyRef = useRef<string | null>(null);

  const syncMessage = (nextDetail: ApiAgentTaskDetail) => {
    useChatStore.getState().updateMessage(messageId, {
      content: buildTaskMessageSummary(nextDetail),
      agentRun: buildTaskBackedAgentRun(nextDetail),
      citations: getTaskFinalResultCitations(nextDetail),
    });
  };

  const loadDetail = async (silent = false) => {
    if (!silent) setIsLoading(true);
    try {
      const nextDetail = await api.agentTasks.get(taskId);
      setDetail(nextDetail);
      syncMessage(nextDetail);
      return nextDetail;
    } catch (error) {
      if (!silent) {
        setStreamError(error instanceof Error ? error.message : "无法加载 Agent 任务");
      }
      return null;
    } finally {
      if (!silent) setIsLoading(false);
    }
  };

  useEffect(() => {
    void loadDetail();
  }, [taskId]);

  useEffect(() => {
    if (
      !detail ||
      (detail.task.status !== "running" &&
        detail.task.status !== "planning" &&
        detail.task.status !== "awaiting_approval")
    ) {
      return;
    }

    const timer = window.setInterval(() => {
      void loadDetail(true);
    }, 4000);

    return () => window.clearInterval(timer);
  }, [detail?.task.status, taskId]);

  const approval = useMemo(() => (detail ? getPendingApproval(detail) : null), [detail]);
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

  useEffect(() => {
    if (!detail) return;
    if (detail.task.status === "failed" || detail.task.status === "awaiting_approval") {
      setExpanded(true);
    }
  }, [detail]);

  useEffect(() => {
    if (!detail || !detail.task.autoStart || detail.task.status !== "draft" || busyAction) {
      return;
    }
    const key = `${detail.task.id}:${detail.task.updatedAt}:${detail.task.status}`;
    if (autoExecuteKeyRef.current === key) return;
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
                current ? { ...current, task: { ...current.task, status: event.status } } : current,
              );
              if (
                event.status === "awaiting_approval" ||
                event.status === "completed" ||
                event.status === "failed"
              ) {
                const refreshed = await loadDetail(true);
                if (refreshed) setDetail(refreshed);
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
              useChatStore.getState().updateMessage(messageId, {
                content: event.content,
                citations: event.citations,
              });
              setDetail((current) => {
                if (!current) return current;
                const artifact: ApiAgentArtifact = {
                  id: `desktop-live-final-${event.runId}`,
                  taskId: current.task.id,
                  runId: event.runId,
                  type: "final_result",
                  title: "Final result",
                  content: event.content,
                  metadata: { live: true, citations: event.citations ?? null },
                  createdAt: new Date().toISOString(),
                  updatedAt: new Date().toISOString(),
                };
                return {
                  ...current,
                  artifacts: [
                    artifact,
                    ...current.artifacts.filter((item) => item.id !== artifact.id),
                  ],
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
          onError: (message) => setStreamError(extractErrorMessage(message, "任务执行失败")),
        },
        {
          response: await responseFactory(),
          action,
        },
      );

      const refreshed = await loadDetail(true);
      if (refreshed) setDetail(refreshed);
    } catch (error) {
      setStreamError(extractErrorMessage(error, "任务执行失败"));
      const refreshed = await loadDetail(true);
      if (refreshed) setDetail(refreshed);
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
    } catch (error) {
      setStreamError(extractErrorMessage(error, "无法更新审批状态"));
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
    } catch (error) {
      setStreamError(extractErrorMessage(error, "无法重新规划任务"));
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
    } catch (error) {
      setStreamError(extractErrorMessage(error, "无法取消任务"));
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

  if (!detail) return null;

  const finalArtifact = getTaskFinalResultArtifact(detail);
  const finalCitations = getTaskFinalResultCitations(detail);
  const finalDisplay = finalArtifact
    ? sanitizeDisplayContent(finalArtifact.content, finalCitations)
    : "";
  const canExecute = detail.task.status === "draft";
  const canRetry =
    detail.task.status === "failed" ||
    detail.task.status === "completed" ||
    detail.task.status === "cancelled";
  const canContinue = detail.task.status === "failed" || detail.task.status === "completed";
  const canCancel = detail.task.status === "running";
  const detailLabel = expanded ? "收起详情" : "查看详情";
  const toolEventCount = executionEvents.filter(
    (event) => getExecutionEventType(event) === "tool_start",
  ).length;

  const statusTone =
    detail.task.status === "completed"
      ? "accent"
      : detail.task.status === "failed"
        ? "danger"
        : "default";

  return (
    <div className="mt-2 overflow-hidden rounded-2xl border border-border/60 bg-muted/15">
      <div className="space-y-3 px-4 py-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 space-y-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <MetaPill
                label={
                  detail.task.status === "awaiting_approval"
                    ? "待审批"
                    : detail.task.status === "running"
                      ? "执行中"
                      : detail.task.status === "planning"
                        ? "规划中"
                        : detail.task.status === "completed"
                          ? "已完成"
                          : detail.task.status === "failed"
                            ? "失败"
                            : detail.task.status === "cancelled"
                              ? "已取消"
                              : "草稿"
                }
                tone={statusTone}
              />
              <MetaPill label={`模式 ${detail.task.uxMode}`} />
              <MetaPill label={`复杂度 ${detail.task.complexity}`} />
            </div>
            <div className="text-sm font-medium">{detail.task.title}</div>
            <p className="text-sm text-muted-foreground">
              {streamError || buildTaskStatusSummary(detail.task.status, detail.task.uxMode)}
            </p>
          </div>

          <Button variant="ghost" size="sm" onClick={() => setExpanded((current) => !current)}>
            {detailLabel}
          </Button>
        </div>

        {approval && (
          <div className="rounded-xl border border-orange-200 bg-orange-50 px-3 py-2.5">
            <div className="flex items-start gap-2">
              <AlertCircle className="mt-0.5 h-4 w-4 text-orange-600" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-orange-700">{approval.title}</p>
                {approval.description ? (
                  <p className="mt-1 text-sm text-orange-700/90">{approval.description}</p>
                ) : null}
                <div className="mt-2 flex gap-2">
                  <Button
                    size="sm"
                    disabled={busyAction === "approve" || busyAction === "reject"}
                    onClick={() => void handleApproval("approved")}
                  >
                    批准
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busyAction === "approve" || busyAction === "reject"}
                    onClick={() => void handleApproval("rejected")}
                  >
                    拒绝
                  </Button>
                </div>
              </div>
            </div>
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          {canExecute && (
            <Button
              size="sm"
              disabled={busyAction !== null}
              onClick={() => void runExecutionAction("execute", () => api.agentTasks.execute(detail.task.id))}
            >
              <Play className="mr-1 h-3.5 w-3.5" />
              开始执行
            </Button>
          )}
          {canContinue && (
            <Button
              size="sm"
              variant="outline"
              disabled={busyAction !== null}
              onClick={() =>
                void runExecutionAction("continue", () => api.agentTasks.continue(detail.task.id))
              }
            >
              <SkipForward className="mr-1 h-3.5 w-3.5" />
              继续
            </Button>
          )}
          {canRetry && (
            <Button
              size="sm"
              variant="outline"
              disabled={busyAction !== null}
              onClick={() => void runExecutionAction("retry", () => api.agentTasks.retry(detail.task.id))}
            >
              <RotateCcw className="mr-1 h-3.5 w-3.5" />
              重试
            </Button>
          )}
          <Button size="sm" variant="outline" disabled={busyAction !== null} onClick={() => void handleReplan()}>
            <Wand2 className="mr-1 h-3.5 w-3.5" />
            重新规划
          </Button>
          {canCancel && (
            <Button size="sm" variant="outline" disabled={busyAction !== null} onClick={() => void handleCancel()}>
              <XCircle className="mr-1 h-3.5 w-3.5" />
              取消
            </Button>
          )}
        </div>
      </div>

      {expanded && (
        <div className="space-y-3 border-t border-border/40 px-4 py-3">
          <Section
            title="执行计划"
            meta={planSteps.length > 0 ? `${planSteps.length} 个步骤` : "当前还没有可展示的计划步骤"}
            icon={<Sparkles className="h-4 w-4" />}
            defaultOpen={Boolean(approval) || detail.task.status === "planning"}
          >
            {planSteps.length === 0 ? (
              <p className="text-sm text-muted-foreground">当前运行没有关联的计划步骤。</p>
            ) : (
              <div className="space-y-2">
                {planSteps.map((step) => (
                  <div key={step.id} className="rounded-xl border border-border/45 bg-background/55 px-3 py-2.5">
                    <div className="flex items-center gap-2">
                      <span className="text-[12px] font-medium">{step.orderIndex + 1}. {step.title}</span>
                      <MetaPill label={step.status} />
                    </div>
                    {step.description ? (
                      <p className="mt-1 text-[12px] leading-5 text-muted-foreground">{step.description}</p>
                    ) : null}
                  </div>
                ))}
              </div>
            )}
          </Section>

          <Section
            title="执行过程"
            meta={
              streamError
                ? "本轮执行出现错误"
                : toolEventCount > 0
                  ? `已调用 ${toolEventCount} 个工具`
                  : "当前还没有执行日志"
            }
            icon={<Wrench className="h-4 w-4" />}
            defaultOpen={Boolean(streamError) || detail.task.status === "failed"}
          >
            {streamError ? (
              <div className="mb-3 rounded-xl border border-destructive/20 bg-destructive/5 px-3 py-2.5 text-sm text-destructive">
                {streamError}
              </div>
            ) : null}

            {executionEvents.filter((event) => event.type === "execution_event" || event.type === "error").length === 0 ? (
              <p className="text-sm text-muted-foreground">当前运行还没有执行日志。</p>
            ) : (
              <div className="space-y-2">
                {executionEvents
                  .filter((event) => event.type === "execution_event" || event.type === "error")
                  .slice(-8)
                  .map((event) => (
                    <div key={event.id} className="rounded-xl border border-border/45 bg-background/55 px-3 py-2.5">
                      <div className="mb-1 flex items-center gap-2 text-[11px] text-muted-foreground">
                        {event.type === "error" ? (
                          <AlertCircle className="h-3.5 w-3.5 text-destructive" />
                        ) : (
                          <Wrench className="h-3.5 w-3.5" />
                        )}
                        <span>{new Date(event.createdAt).toLocaleTimeString()}</span>
                      </div>
                      <p className="text-[12px] leading-5 text-foreground/90">
                        {summarizeExecutionEvent(event) || "执行状态已更新。"}
                      </p>
                    </div>
                  ))}
              </div>
            )}
          </Section>

          <Section
            title="结果与产物"
            meta={
              executionArtifacts.length > 0
                ? `${executionArtifacts.length} 项结果可查看`
                : detail.task.status === "completed"
                  ? "最终结果已生成"
                  : "执行完成后会在这里汇总"
            }
            icon={<PackageOpen className="h-4 w-4" />}
            defaultOpen={detail.task.status === "completed"}
          >
            {finalArtifact ? (
              <div className="space-y-3">
                <div className="rounded-xl border border-border/45 bg-background/55 px-3 py-2.5">
                  <div className="mb-2 flex items-center gap-2 text-[12px] font-medium text-foreground/85">
                    <FileText className="h-4 w-4" />
                    最终结果
                  </div>
                  <DesktopMarkdownMessage content={finalDisplay} />
                  <DesktopCitationList citations={finalCitations} content={finalDisplay} />
                </div>

                {executionArtifacts
                  .filter((artifact) => artifact.type !== "final_result")
                  .slice(0, 4)
                  .map((artifact) => (
                    <div key={artifact.id} className="rounded-xl border border-border/45 bg-background/55 px-3 py-2.5">
                      <div className="text-[12px] font-medium">{artifact.title}</div>
                      <p className="mt-1 whitespace-pre-wrap text-[12px] leading-5 text-muted-foreground">
                        {artifact.content}
                      </p>
                    </div>
                  ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">当前运行暂时没有可展示的结果。</p>
            )}
          </Section>
        </div>
      )}

      {busyAction && (
        <div className="flex items-center gap-2 border-t border-border/40 px-4 py-2 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          正在处理任务操作...
        </div>
      )}
    </div>
  );
}
