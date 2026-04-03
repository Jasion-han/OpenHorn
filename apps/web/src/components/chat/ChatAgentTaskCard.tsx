"use client";

import { AlertCircle, Loader2, Play, RotateCcw, SkipForward, Square, Wand2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { type AgentTaskStreamEvent, streamAgentTaskExecution } from "@/lib/agent-task-stream";
import {
  type ApiAgentApproval,
  type ApiAgentArtifact,
  type ApiAgentRun,
  type ApiAgentTaskDetail,
  type ApiAgentTaskEvent,
  api,
  extractErrorMessage,
} from "@/lib/api";
import { getArtifactCitations, sanitizeDisplayContent } from "@/lib/citations";
import { notifyError, notifySuccess } from "@/lib/notify";
import { cn } from "@/lib/utils";
import { useChatStore } from "@/stores/chatStore";

type ToolApprovalPayload = {
  toolUseId?: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  blockedPath?: string | null;
  decisionReason?: string | null;
};

type StreamTone = "default" | "success" | "warning" | "danger";

type StreamItem = {
  id: string;
  kind: "meta" | "output";
  label?: string;
  text: string;
  subtext?: string | null;
  tone?: StreamTone;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getTaskFinalResultArtifact(detail: ApiAgentTaskDetail) {
  return detail.artifacts.find((artifact) => artifact.type === "final_result") ?? null;
}

function getTaskFinalResultCitations(detail: ApiAgentTaskDetail) {
  return getArtifactCitations(getTaskFinalResultArtifact(detail));
}

function buildTaskMessageSummary(detail: ApiAgentTaskDetail) {
  const finalResultCitations = getTaskFinalResultCitations(detail);
  const finalResult = sanitizeDisplayContent(
    getTaskFinalResultArtifact(detail)?.content ?? "",
    finalResultCitations,
  ).trim();
  if (detail.task.status === "completed" && finalResult) return finalResult;

  const preview = sanitizeDisplayContent(
    detail.task.insight?.previewText ?? "",
    finalResultCitations,
  ).trim();

  return preview || taskStatusSummary(detail.task.status);
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

function getPendingApproval(detail: ApiAgentTaskDetail): ApiAgentApproval | null {
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

function getRunEvents(detail: ApiAgentTaskDetail, runId: string | null): ApiAgentTaskEvent[] {
  if (!runId) return [];
  return detail.events.filter((event) => event.runId === runId);
}

function mergeExecutionEvent(detail: ApiAgentTaskDetail, nextEvent: ApiAgentTaskEvent) {
  const events = [...detail.events];
  const last = events[events.length - 1];
  const lastEventType = last && isRecord(last.metadata) ? last.metadata.eventType : null;
  const nextEventType = isRecord(nextEvent.metadata) ? nextEvent.metadata.eventType : null;

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
    id: `chat-live-${Date.now()}-${Math.random()}`,
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

function getToolApprovalPayload(payload: unknown): ToolApprovalPayload | null {
  if (!isRecord(payload)) return null;
  return {
    toolUseId: typeof payload.toolUseId === "string" ? payload.toolUseId : undefined,
    toolName: typeof payload.toolName === "string" ? payload.toolName : undefined,
    toolInput: isRecord(payload.toolInput) ? payload.toolInput : undefined,
    blockedPath: typeof payload.blockedPath === "string" ? payload.blockedPath : null,
    decisionReason: typeof payload.decisionReason === "string" ? payload.decisionReason : null,
  };
}

function normalizeToolName(toolName: string | null | undefined) {
  return (toolName ?? "").trim().toLowerCase();
}

function simplifyToolName(toolName: string | null | undefined) {
  const normalized = normalizeToolName(toolName);
  if (!normalized) return "tool";
  if (normalized.startsWith("mcp__")) {
    const parts = normalized.split("__").filter(Boolean);
    return parts.slice(1).join(".") || "mcp";
  }
  if (normalized.startsWith("skill__")) {
    const parts = normalized.split("__").filter(Boolean);
    return parts.slice(1).join(".") || "skill";
  }
  return normalized.replace(/\s+/g, "_");
}

function actionLabel(toolName: string | null | undefined) {
  const normalized = normalizeToolName(toolName);
  if (!normalized) return "tool";
  if (normalized.includes("bash") || normalized.includes("terminal") || normalized === "shell") {
    return "bash";
  }
  if (normalized.startsWith("mcp__")) return "mcp";
  if (normalized.startsWith("skill__")) return "skill";
  if (normalized.includes("fetch")) return "fetch";
  if (normalized.includes("search")) return "search";
  if (normalized.includes("browser")) return "browser";
  if (normalized.includes("read")) return "read";
  if (normalized.includes("write") || normalized.includes("edit")) return "write";
  return simplifyToolName(toolName);
}

function summarizeApprovalToolInput(toolInput: Record<string, unknown> | undefined) {
  if (!toolInput) return null;

  if (typeof toolInput.command === "string" && toolInput.command.trim()) {
    return toolInput.command.trim();
  }

  const preferredKeys = ["file_path", "path", "pattern", "query", "url"];
  const lines = preferredKeys
    .map((key) => {
      const value = toolInput[key];
      if (typeof value !== "string" || !value.trim()) return null;
      return value.trim();
    })
    .filter((value): value is string => Boolean(value));

  if (lines.length > 0) return lines.join(" · ");

  try {
    return JSON.stringify(toolInput);
  } catch {
    return null;
  }
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
  if (query) {
    return query.length > 72 ? `${query.slice(0, 69)}...` : query;
  }

  const url = typeof input.url === "string" ? input.url : null;
  if (url) {
    return url.length > 72 ? `${url.slice(0, 69)}...` : url;
  }

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
  if (command) {
    return command.length > 72 ? `${command.slice(0, 69)}...` : command;
  }

  return null;
}

function summarizeEventContent(content: string | null | undefined) {
  const normalized = (content ?? "").trim().replace(/\s+/g, " ");
  if (!normalized) return null;
  return normalized.length > 160 ? `${normalized.slice(0, 157)}...` : normalized;
}

function taskStatusSummary(status: ApiAgentTaskDetail["task"]["status"]) {
  switch (status) {
    case "planning":
      return "building plan";
    case "awaiting_approval":
      return "waiting for approval";
    case "running":
      return "working";
    case "completed":
      return "done";
    case "failed":
      return "blocked on error";
    case "cancelled":
      return "stopped";
    default:
      return "ready";
  }
}

function taskStatusToken(status: ApiAgentTaskDetail["task"]["status"]) {
  switch (status) {
    case "planning":
      return "planning";
    case "awaiting_approval":
      return "approval";
    case "running":
      return "running";
    case "completed":
      return "done";
    case "failed":
      return "failed";
    case "cancelled":
      return "stopped";
    default:
      return "ready";
  }
}

function depthToken(complexity: ApiAgentTaskDetail["task"]["complexity"]) {
  switch (complexity) {
    case "light":
      return "light";
    case "deep":
      return "deep";
    default:
      return "standard";
  }
}

function mergeOutputRows(items: StreamItem[]) {
  const merged: StreamItem[] = [];
  for (const item of items) {
    const last = merged[merged.length - 1];
    if (item.kind === "output" && last?.kind === "output") {
      last.text = `${last.text}\n\n${item.text}`.trim();
      continue;
    }
    merged.push({ ...item });
  }
  return merged;
}

function buildPlanItems(detail: ApiAgentTaskDetail, approval: ApiAgentApproval | null): StreamItem[] {
  return getPlanStepsForDetail(detail, approval).map((step) => ({
    id: `plan-${step.id}`,
    kind: "meta",
    label: "plan",
    text: step.title,
    subtext: step.description,
    tone:
      step.status === "completed"
        ? "success"
        : step.status === "failed"
          ? "danger"
          : step.status === "running" || step.status === "ready"
            ? "warning"
            : "default",
  }));
}

function buildExecutionItems(events: ApiAgentTaskEvent[]): StreamItem[] {
  const items: StreamItem[] = [];

  for (const event of events) {
    if (event.type === "error") {
      items.push({
        id: event.id,
        kind: "meta",
        label: "thinking",
        text: summarizeEventContent(event.content) || "run failed",
        tone: "danger",
      });
      continue;
    }

    if (event.type !== "execution_event") continue;

    const eventType = isRecord(event.metadata) ? event.metadata.eventType : null;
    if (eventType === "text") {
      const text = (event.content ?? "").trim();
      if (text) {
        items.push({ id: event.id, kind: "output", text });
      }
      continue;
    }

    const label = actionLabel(event.toolName);
    const name = simplifyToolName(event.toolName);

    if (eventType === "tool_start") {
      items.push({
        id: event.id,
        kind: "meta",
        label,
        text: summarizeToolInput(event.toolInput) || name,
        subtext: name !== label ? name : null,
        tone: "default",
      });
      continue;
    }

    if (eventType === "tool_result") {
      items.push({
        id: event.id,
        kind: "meta",
        label,
        text: summarizeEventContent(event.content) || `${name} done`,
        tone: "success",
      });
    }
  }

  return mergeOutputRows(items);
}

function buildApprovalItems(approval: ApiAgentApproval | null): StreamItem[] {
  if (!approval || approval.status !== "pending") return [];

  if (approval.type === "tool_approval") {
    const payload = getToolApprovalPayload(approval.payload);
    return [
      {
        id: `approval-thinking-${approval.id}`,
        kind: "meta",
        label: "thinking",
        text: "approval required",
        subtext: payload?.decisionReason || approval.description,
        tone: "warning",
      },
      {
        id: `approval-tool-${approval.id}`,
        kind: "meta",
        label: actionLabel(payload?.toolName),
        text: summarizeApprovalToolInput(payload?.toolInput) || simplifyToolName(payload?.toolName),
        tone: "warning",
      },
    ];
  }

  return [
    {
      id: `approval-${approval.id}`,
      kind: "meta",
      label: "thinking",
      text: "waiting for approval",
      subtext: approval.description,
      tone: "warning",
    },
  ];
}

function buildStatusItems(detail: ApiAgentTaskDetail, streamError: string | null): StreamItem[] {
  const items: StreamItem[] = [];

  if (detail.task.status !== "completed") {
    items.push({
      id: `status-${detail.task.id}-${detail.task.updatedAt}`,
      kind: "meta",
      label: "thinking",
      text: taskStatusSummary(detail.task.status),
      tone:
        detail.task.status === "failed"
          ? "danger"
          : detail.task.status === "awaiting_approval"
            ? "warning"
            : "default",
    });
  }

  if (streamError) {
    items.push({
      id: `stream-error-${detail.task.id}`,
      kind: "meta",
      label: "thinking",
      text: streamError,
      tone: "danger",
    });
  }

  return items;
}

function buildOutputItems(detail: ApiAgentTaskDetail): StreamItem[] {
  const finalResultCitations = getTaskFinalResultCitations(detail);
  const finalResult = sanitizeDisplayContent(
    getTaskFinalResultArtifact(detail)?.content ?? "",
    finalResultCitations,
  ).trim();

  if (!finalResult) return [];
  return [
    {
      id: `final-output-${detail.task.id}`,
      kind: "output",
      text: finalResult,
    },
  ];
}

function buildStream(detail: ApiAgentTaskDetail, streamError: string | null): StreamItem[] {
  const approval = getPendingApproval(detail);
  const executionRun = getLatestExecutionRun(detail);
  const executionItems = buildExecutionItems(getRunEvents(detail, executionRun?.id ?? null));
  const finalOutputItems = buildOutputItems(detail);

  const items = mergeOutputRows([
    ...buildStatusItems(detail, streamError),
    ...buildPlanItems(detail, approval),
    ...buildApprovalItems(approval),
    ...executionItems,
    ...(finalOutputItems.length > 0 ? finalOutputItems : []),
  ]);

  if (items.length > 0) return items;
  return [
    {
      id: `empty-${detail.task.id}`,
      kind: "meta",
      label: "thinking",
      text: "ready",
    },
  ];
}

function toneClassName(tone: StreamTone = "default") {
  switch (tone) {
    case "success":
      return "text-foreground/45";
    case "warning":
      return "text-foreground/40";
    case "danger":
      return "text-destructive/70";
    default:
      return "text-foreground/38";
  }
}

function buildCapabilityTokens(detail: ApiAgentTaskDetail, stream: StreamItem[]) {
  const tokens = [taskStatusToken(detail.task.status), depthToken(detail.task.complexity), "local"];
  if (detail.task.attachments.length > 0) tokens.push("files");
  if (stream.some((item) => item.label === "fetch" || item.label === "search" || item.label === "browser")) {
    tokens.push("web");
  }
  if (stream.some((item) => item.label && !["thinking", "plan"].includes(item.label))) {
    tokens.push("tools");
  }
  return [...new Set(tokens)].join(" · ");
}

export function ChatAgentTaskCard({ messageId, taskId }: { messageId: string; taskId: string }) {
  const [detail, setDetail] = useState<ApiAgentTaskDetail | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [busyAction, setBusyAction] = useState<
    "approve" | "reject" | "execute" | "retry" | "continue" | "replan" | "cancel" | null
  >(null);
  const [streamError, setStreamError] = useState<string | null>(null);
  const autoExecuteKeyRef = useRef<string | null>(null);

  const syncMessage = (nextDetail: ApiAgentTaskDetail) => {
    useChatStore.getState().updateMessage(messageId, buildTaskMessageSummary(nextDetail), {
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
        notifyError("加载任务失败", error instanceof Error ? error.message : "无法加载 Agent 任务");
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

  useEffect(() => {
    if (!detail || !detail.task.autoStart || detail.task.status !== "draft") return;
    const key = `${detail.task.id}:${detail.task.updatedAt}:${detail.task.status}`;
    if (autoExecuteKeyRef.current === key || busyAction !== null) return;
    autoExecuteKeyRef.current = key;
    void runExecutionAction("execute", () => api.agentTasks.execute(detail.task.id));
  }, [detail, busyAction]);

  const approval = useMemo(() => (detail ? getPendingApproval(detail) : null), [detail]);

  const runExecutionAction = async (
    action: "execute" | "retry" | "continue",
    responseFactory: () => Promise<Response>,
  ) => {
    if (!detail) return;
    setBusyAction(action);
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
              useChatStore.getState().updateMessage(messageId, event.content, {
                citations: event.citations,
              });
              setDetail((current) => {
                if (!current) return current;
                const artifact: ApiAgentArtifact = {
                  id: `chat-live-final-${event.runId}`,
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
      if (refreshed) setDetail(refreshed);
    } catch (error) {
      const message = extractErrorMessage(error, "任务执行失败");
      setStreamError(message);
      notifyError("任务执行失败", message);
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

  const stream = useMemo(() => (detail ? buildStream(detail, streamError) : []), [detail, streamError]);
  const metaLine = detail ? buildCapabilityTokens(detail, stream) : "";

  if (isLoading && !detail) {
    return <div className="mt-2 px-1 py-2 text-sm text-muted-foreground">loading...</div>;
  }

  if (!detail) return null;

  const canExecute = detail.task.status === "draft";
  const canRetry =
    detail.task.status === "failed" ||
    detail.task.status === "completed" ||
    detail.task.status === "cancelled";
  const canContinue = detail.task.status === "failed" || detail.task.status === "completed";
  const canCancel = detail.task.status === "running";

  return (
    <section className="mt-2 px-1 py-2">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-foreground/88">{detail.task.title}</div>
          <div className="mt-1 font-mono text-[11px] text-foreground/35">{metaLine}</div>
        </div>
        {busyAction ? <Loader2 className="mt-0.5 h-4 w-4 animate-spin text-foreground/35" /> : null}
      </div>

      <div className="mt-3 space-y-3">
        {stream.map((item) =>
          item.kind === "meta" ? (
            <div key={item.id} className={cn("font-mono text-[11px] leading-6", toneClassName(item.tone))}>
              <span className="lowercase">{item.label ?? "meta"}</span>
              <span className="px-1">:</span>
              <span>{item.text}</span>
              {item.subtext ? <span className="text-foreground/28"> · {item.subtext}</span> : null}
            </div>
          ) : (
            <div key={item.id} className="whitespace-pre-wrap break-words text-[14px] leading-7 text-foreground">
              {item.text}
            </div>
          ),
        )}
      </div>

      {approval ? (
        <div className="mt-4 flex flex-wrap items-center gap-2 pt-1">
          <AlertCircle className="h-3.5 w-3.5 text-foreground/35" />
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
      ) : null}

      <div className="mt-4 flex flex-wrap items-center gap-2 pt-1">
        {canExecute ? (
          <Button size="sm" onClick={() => void runExecutionAction("execute", () => api.agentTasks.execute(detail.task.id))} disabled={busyAction !== null}>
            <Play className="mr-1.5 h-3.5 w-3.5" />
            开始执行
          </Button>
        ) : null}
        {canContinue ? (
          <Button size="sm" variant="outline" onClick={() => void runExecutionAction("continue", () => api.agentTasks.continue(detail.task.id))} disabled={busyAction !== null}>
            <SkipForward className="mr-1.5 h-3.5 w-3.5" />
            继续
          </Button>
        ) : null}
        {canRetry ? (
          <Button size="sm" variant="outline" onClick={() => void runExecutionAction("retry", () => api.agentTasks.retry(detail.task.id))} disabled={busyAction !== null}>
            <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
            重试
          </Button>
        ) : null}
        <Button size="sm" variant="outline" onClick={() => void handleReplan()} disabled={busyAction !== null}>
          <Wand2 className="mr-1.5 h-3.5 w-3.5" />
          重新规划
        </Button>
        {canCancel ? (
          <Button size="sm" variant="outline" onClick={() => void handleCancel()} disabled={busyAction !== null}>
            <Square className="mr-1.5 h-3.5 w-3.5" />
            取消
          </Button>
        ) : null}
      </div>
    </section>
  );
}
