import { type CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import { cn } from "ui";
import { streamAgentTaskExecution, type AgentTaskStreamEvent } from "../../lib/agentTaskStream";
import { sanitizeDisplayContent } from "../../lib/citations";
import { notifyError } from "../../lib/notify";
import { createServerApi } from "../../lib/serverApi";
import { useChatStore } from "../../stores/chatStore";
import type {
  ApiAgentApproval,
  ApiAgentArtifact,
  ApiAgentRun,
  ApiAgentTaskDetail,
  ApiAgentTaskEvent,
  ApiCitation,
} from "../../types/chat";
import { DesktopCitationList } from "./DesktopCitationList";
import { DesktopMarkdownMessage } from "./DesktopMarkdownMessage";
import { DesktopStreamingMarkdownMessage } from "./DesktopStreamingMarkdownMessage";

const api = createServerApi();
const autoExecutingTaskIds = new Set<string>();

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
  active?: boolean;
  mergeKey?: string;
  streaming?: boolean;
};

function extractErrorMessage(error: unknown, fallback = "task failed") {
  if (typeof error === "string") return error.trim() || fallback;
  if (error instanceof Error) return error.message.trim() || fallback;
  return fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getArtifactCitations(artifact: ApiAgentArtifact | null | undefined): ApiCitation[] | undefined {
  if (!artifact || !isRecord(artifact.metadata)) return undefined;
  const citations = artifact.metadata.citations;
  return Array.isArray(citations) ? (citations as ApiCitation[]) : undefined;
}

function getTaskFinalResultArtifact(detail: ApiAgentTaskDetail) {
  return detail.artifacts.find((artifact) => artifact.type === "final_result") ?? null;
}

function getTaskFinalResultCitations(detail: ApiAgentTaskDetail) {
  return getArtifactCitations(getTaskFinalResultArtifact(detail));
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
  if (normalized.includes("write")) return "write";
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

function getExecutionEventType(event: ApiAgentTaskEvent) {
  return isRecord(event.metadata) ? event.metadata.eventType : null;
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

function summarizeProcessDetail(content: string | null | undefined, limit = 96) {
  const normalized = (content ?? "").trim().replace(/\s+/g, " ");
  if (!normalized) return null;
  return normalized.length > limit ? `${normalized.slice(0, limit - 3)}...` : normalized;
}

function normalizeProcessText(content: string | null | undefined) {
  const normalized = sanitizeDisplayContent(content ?? "").trim().replace(/\s+/g, " ");
  return normalized || null;
}

function presentActionLabel(label: string) {
  switch (label) {
    case "bash":
      return "Bash";
    case "search":
      return "Search";
    case "fetch":
      return "Fetch";
    case "read":
      return "Read";
    case "write":
      return "Write";
    case "browser":
      return "Browser";
    case "mcp":
      return "MCP";
    case "skill":
      return "Skill";
    default:
      return label ? label.charAt(0).toUpperCase() + label.slice(1) : "Tool";
  }
}

function prettifyToolName(toolName: string | null | undefined) {
  const simplified = simplifyToolName(toolName);
  return simplified.replace(/[._-]+/g, " ").trim() || "tool";
}

function describeToolStart(toolName: string | null | undefined, toolInput: ApiAgentTaskEvent["toolInput"]) {
  const label = actionLabel(toolName);
  const detail = summarizeToolInput(toolInput);
  return {
    text: presentActionLabel(label),
    subtext: detail,
  };
}

function describeToolResult(toolName: string | null | undefined, content: string | null | undefined) {
  const label = actionLabel(toolName);
  const lines = (content ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const exitLine = lines.find((line) => line.startsWith("exit_code:"));
  const stdoutLine = lines.find((line) => !line.startsWith("stdout:") && !line.startsWith("stderr:"));
  const detail = summarizeProcessDetail(
    [exitLine?.replace("exit_code:", "exit"), stdoutLine].filter(Boolean).join(" · ") || content,
    84,
  );
  return {
    text: presentActionLabel(label),
    subtext: detail,
  };
}

function describeTaskStatus(status: ApiAgentTaskDetail["task"]["status"]) {
  switch (status) {
    case "planning":
      return { text: "Thinking", tone: "default" as const };
    case "awaiting_approval":
      return { text: "Awaiting confirmation", tone: "warning" as const };
    case "running":
      return { text: "Working", tone: "default" as const };
    case "completed":
      return { text: "Done", tone: "success" as const };
    case "failed":
      return { text: "Error", tone: "danger" as const };
    case "cancelled":
      return { text: "Stopped", tone: "danger" as const };
    default:
      return { text: "Ready", tone: "default" as const };
  }
}

function getTaskStatusValue(event: ApiAgentTaskEvent) {
  if (!isRecord(event.metadata)) return null;
  return typeof event.metadata.status === "string" ? event.metadata.status : null;
}

function getPlanStepMeta(event: ApiAgentTaskEvent) {
  if (!isRecord(event.metadata)) return { status: null, description: null };
  return {
    status: typeof event.metadata.status === "string" ? event.metadata.status : null,
    description: typeof event.metadata.description === "string" ? event.metadata.description : null,
  };
}

function getApprovalEventMeta(event: ApiAgentTaskEvent) {
  if (!isRecord(event.metadata)) return { type: null, status: null };
  return {
    type: typeof event.metadata.approvalType === "string" ? event.metadata.approvalType : null,
    status: typeof event.metadata.status === "string" ? event.metadata.status : null,
  };
}

function describeApprovalResolution(event: ApiAgentTaskEvent) {
  const meta = getApprovalEventMeta(event);
  const normalized = (event.content ?? "").trim().toLowerCase();
  const type =
    meta.type ??
    (normalized.includes("tool_approval")
      ? "tool_approval"
      : normalized.includes("plan_approval")
        ? "plan_approval"
        : null);
  const status =
    meta.status ??
    (normalized.includes("approved") ? "approved" : normalized.includes("rejected") ? "rejected" : null);

  if (type === "tool_approval") {
    if (status === "approved") return { text: "Approved", tone: "success" as const };
    if (status === "rejected") return { text: "Rejected", tone: "danger" as const };
  }

  if (type === "plan_approval") {
    if (status === "approved") return { text: "Approved", tone: "success" as const };
    if (status === "rejected") return { text: "Rejected", tone: "danger" as const };
  }

  return {
    text: status === "rejected" ? "Rejected" : "Approved",
    tone: status === "rejected" ? ("danger" as const) : ("success" as const),
  };
}

function taskStatusSummary(status: ApiAgentTaskDetail["task"]["status"]) {
  switch (status) {
    case "planning":
      return "building plan";
    case "awaiting_approval":
      return "paused";
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

function isLowSignalFallbackOutput(text: string | null | undefined) {
  const normalized = sanitizeDisplayContent(text ?? "").trim();
  if (!normalized) return true;

  return (
    normalized === "Agent 正在执行" ||
    normalized === "我先直接处理这项任务。" ||
    normalized === "正在整理最短执行路径。" ||
    normalized === "正在直接处理这项任务。" ||
    normalized === "任务已完成。" ||
    normalized === "任务处理失败，可继续或重试。" ||
    normalized === "任务已取消。" ||
    normalized === "正在整理简要步骤并开始执行。" ||
    normalized === "正在按简要步骤处理这项任务。" ||
    normalized === "任务处理失败，可以重试或查看过程。" ||
    normalized === "我会按简要步骤直接开始处理。" ||
    normalized === "正在整理执行路径并开始执行。" ||
    normalized === "任务暂时停下，等待进一步批准。" ||
    normalized === "任务正在执行。" ||
    normalized === "任务执行失败，可继续、重试或重新规划。" ||
    normalized === "我会先展开任务并开始执行。" ||
    normalized === "building plan" ||
    normalized === "paused" ||
    normalized === "working" ||
    normalized === "done" ||
    normalized === "blocked on error" ||
    normalized === "stopped" ||
    normalized === "ready" ||
    normalized.startsWith("Execution completed.")
  );
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

function isLowSignalTaskSummary(text: string | null | undefined, detail: ApiAgentTaskDetail) {
  const normalized = (text ?? "").trim();
  if (!normalized) return true;
  return (
    normalized === taskStatusSummary(detail.task.status) ||
    normalized === "ready" ||
    normalized === "working" ||
    normalized.startsWith("Execution completed.")
  );
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

function mergeExecutionEvent(detail: ApiAgentTaskDetail, nextEvent: ApiAgentTaskEvent) {
  const nextEventType = isRecord(nextEvent.metadata) ? nextEvent.metadata.eventType : null;
  if (nextEvent.type === "execution_event" && nextEventType === "text_reset") {
    return {
      ...detail,
      events: detail.events.filter((event) => {
        if (event.type !== "execution_event" || !isRecord(event.metadata)) return true;
        const eventType = event.metadata.eventType;
        const isLive = Boolean(event.metadata.live);
        return !isLive || (eventType !== "text" && eventType !== "text_delta");
      }),
    };
  }

  const events = [...detail.events];
  const last = events[events.length - 1];
  const lastEventType = last && isRecord(last.metadata) ? last.metadata.eventType : null;

  if (
    nextEvent.type === "execution_event" &&
    (nextEventType === "text" || nextEventType === "text_delta") &&
    last?.type === "execution_event" &&
    (lastEventType === "text" || lastEventType === "text_delta")
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
  if (
    event.type !== "execution_event" &&
    event.type !== "error" &&
    event.type !== "task_status" &&
    event.type !== "plan_step"
  ) {
    return null;
  }

  if (event.type === "task_status" || event.type === "plan_step") return null;

  const eventMetadata =
    event.type === "execution_event" && isRecord(event.metadata) ? event.metadata : null;

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
      ...(eventMetadata ?? {}),
      live: true,
    },
    createdAt: new Date().toISOString(),
  };
}

function mergeOutputRows(items: StreamItem[]) {
  const merged: StreamItem[] = [];
  for (const item of items) {
    if (item.mergeKey) {
      const existingIndex = merged.findIndex((entry) => entry.mergeKey === item.mergeKey);
      if (existingIndex >= 0) {
        merged[existingIndex] = { ...item };
        continue;
      }
    }

    const last = merged[merged.length - 1];
    if (
      item.kind === "meta" &&
      last?.kind === "meta" &&
      last.text === item.text &&
      last.subtext === item.subtext &&
      last.tone === item.tone
    ) {
      merged[merged.length - 1] = { ...item };
      continue;
    }

    if (item.kind === "output" && last?.kind === "output") {
      last.text = `${last.text}\n\n${item.text}`.trim();
      continue;
    }
    merged.push({ ...item });
  }
  return merged;
}

function buildExecutionItems(events: ApiAgentTaskEvent[]) {
  const items: StreamItem[] = [];

  for (const event of events) {
    if (event.type === "error") {
      items.push({
        id: event.id,
        kind: "meta",
        text: summarizeProcessDetail(event.content) || "Stopped after an error",
        tone: "danger",
      });
      continue;
    }

    if (event.type !== "execution_event") continue;

    const eventType = getExecutionEventType(event);
    if (eventType === "thought") {
      const text = normalizeProcessText(event.content);
      if (text) {
        items.push({
          id: event.id,
          kind: "meta",
          label: "thinking",
          text,
          tone: "default",
          mergeKey: `thought-${event.id}`,
        });
      }
      continue;
    }

    const label = actionLabel(event.toolName);
    const name = simplifyToolName(event.toolName);

    if (eventType === "tool_start") {
      const start = describeToolStart(event.toolName, event.toolInput);
      items.push({
        id: event.id,
        kind: "meta",
        label,
        text: start.text,
        subtext: start.subtext || (name !== label ? prettifyToolName(event.toolName) : null),
        tone: "default",
      });
      continue;
    }

    if (eventType === "tool_result") {
      const result = describeToolResult(event.toolName, event.content);
      items.push({
        id: event.id,
        kind: "meta",
        label,
        text: result.text,
        subtext: result.subtext,
        tone: "success",
      });
      continue;
    }

    if (eventType === "text" || eventType === "text_delta") {
      const text = normalizeProcessText(event.content);
      if (text) {
        items.push({
          id: event.id,
          kind: "output",
          text,
          streaming: true,
          mergeKey: `execution-output-${event.id}`,
        });
      }
    }
  }

  return mergeOutputRows(items);
}

function buildTimelineItems(detail: ApiAgentTaskDetail): StreamItem[] {
  const items: StreamItem[] = [];
  const events = [...detail.events].sort(
    (left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime(),
  );
  const hasExplicitErrorEvent = events.some((event) => event.type === "error");

  for (const event of events) {
    if (event.type === "task_status") {
      const statusValue = getTaskStatusValue(event);
      if (
        statusValue &&
        (statusValue === "failed" || statusValue === "cancelled") &&
        !(statusValue === "failed" && hasExplicitErrorEvent)
      ) {
        const status = describeTaskStatus(statusValue as ApiAgentTaskDetail["task"]["status"]);
        items.push({
          id: event.id,
          kind: "meta",
          label: statusValue === "failed" || statusValue === "cancelled" ? "error" : "thinking",
          text: status.text,
          tone: status.tone,
        });
      }
      continue;
    }

    if (event.type === "execution_event") {
      items.push(...buildExecutionItems([event]));
      continue;
    }

    if (event.type === "plan_step") {
      const meta = getPlanStepMeta(event);
      if (meta.status === "pending") {
        continue;
      }

      const planStepText = normalizeProcessText(event.content) || "Planned step";

      items.push({
        id: event.id,
        kind: "meta",
        label: "thinking",
        text: planStepText,
        tone:
          meta.status === "completed"
            ? "success"
            : meta.status === "failed"
              ? "danger"
              : "default",
        mergeKey: `plan-step-${planStepText.toLowerCase()}`,
      });
      continue;
    }

    if (event.type === "approval_requested") {
      const approvalType = isRecord(event.metadata) ? event.metadata.approvalType : null;
      items.push({
        id: event.id,
        kind: "meta",
        label: "thinking",
        text:
          approvalType === "tool_approval" ? "Awaiting confirmation" : "Awaiting start",
        tone: "warning",
      });
      continue;
    }

    if (event.type === "approval_resolved") {
      const resolution = describeApprovalResolution(event);
      items.push({
        id: event.id,
        kind: "meta",
        label: resolution.tone === "danger" ? "error" : "thinking",
        text: resolution.text,
        tone: resolution.tone,
      });
      continue;
    }

    if (event.type === "error") {
      items.push({
        id: event.id,
        kind: "meta",
        label: "error",
        text: summarizeProcessDetail(event.content) || "Stopped after an error",
        tone: "danger",
      });
    }
  }

  return mergeOutputRows(items);
}

function buildApprovalItems(approval: ApiAgentApproval | null): StreamItem[] {
  if (!approval || approval.status !== "pending") return [];

  if (approval.type === "tool_approval") {
    const payload = getToolApprovalPayload(approval.payload);
    const start = describeToolStart(payload?.toolName, payload?.toolInput);
    return [
      {
        id: `approval-thinking-${approval.id}`,
        kind: "meta",
        label: "thinking",
        text: "Awaiting confirmation",
        tone: "warning",
      },
      {
        id: `approval-tool-${approval.id}`,
        kind: "meta",
        label: actionLabel(payload?.toolName),
        text: start.text,
        subtext: start.subtext || summarizeApprovalToolInput(payload?.toolInput) || prettifyToolName(payload?.toolName),
        tone: "warning",
      },
    ];
  }

  return [
    {
      id: `approval-${approval.id}`,
      kind: "meta",
      label: "thinking",
      text: "Awaiting start",
      tone: "warning",
    },
  ];
}

function buildStatusItems(streamError: string | null): StreamItem[] {
  const items: StreamItem[] = [];

  if (streamError) {
    items.push({
      id: "stream-error",
      kind: "meta",
      label: "error",
      text: streamError,
      tone: "danger",
    });
  }

  return items;
}

function appendCurrentProcessItem(items: StreamItem[], detail: ApiAgentTaskDetail) {
  if (!["planning", "running", "awaiting_approval"].includes(detail.task.status)) {
    return items;
  }

  const latestMeta = [...items].reverse().find((item) => item.kind === "meta");
  if (latestMeta && latestMeta.tone !== "success") {
    return items;
  }

  const status = describeTaskStatus(detail.task.status);
  return [
    ...items,
    {
      id: `current-process-${detail.task.id}`,
      kind: "meta" as const,
      label: "thinking",
      text: status.text,
      tone: status.tone,
      mergeKey: `current-process-${detail.task.status}`,
    },
  ];
}

function markActiveMetaItem(items: StreamItem[], detail: ApiAgentTaskDetail) {
  if (["completed", "failed", "cancelled"].includes(detail.task.status)) {
    return items;
  }

  const nextItems = items.map((item) => ({ ...item, active: false }));
  const activeIndex = [...nextItems]
    .map((item, index) => ({ item, index }))
    .reverse()
    .find(({ item }) => item.kind === "meta" && item.tone !== "success" && item.tone !== "danger")?.index;

  if (typeof activeIndex === "number") {
    nextItems[activeIndex].active = true;
  }

  return nextItems;
}

function normalizeHistoricalMetaItems(items: StreamItem[], detail: ApiAgentTaskDetail) {
  if (!["completed", "failed", "cancelled"].includes(detail.task.status)) {
    return items;
  }

  return items.map((item) =>
    item.kind !== "meta" || item.tone === "danger"
      ? item
      : {
          ...item,
          tone: "default" as const,
          active: false,
        },
  );
}

function buildOutputItems(detail: ApiAgentTaskDetail, fallbackContent: string | null | undefined): StreamItem[] {
  const isTerminal = ["completed", "failed", "cancelled"].includes(detail.task.status);
  const executionText = detail.events
    .filter((event) => event.type === "execution_event" && getExecutionEventType(event) === "text")
    .map((event) => event.content ?? "")
    .join("")
    .trim();

  const finalResultCitations = getTaskFinalResultCitations(detail);
  const finalResult = sanitizeDisplayContent(
    getTaskFinalResultArtifact(detail)?.content ?? "",
    finalResultCitations,
  ).trim();

  if (finalResult) {
    return [
      {
        id: `final-output-${detail.task.id}`,
        kind: "output",
        text: finalResult,
        streaming: false,
      },
    ];
  }

  if (executionText && detail.task.status === "completed") {
    return [
      {
        id: `execution-output-${detail.task.id}`,
        kind: "output",
        text: executionText,
        streaming: false,
      },
    ];
  }

  if (!isTerminal) return [];

  const fallback = sanitizeDisplayContent(fallbackContent ?? "").trim();
  if (
    !fallback ||
    fallback === taskStatusSummary(detail.task.status) ||
    fallback === "Agent 正在执行" ||
    fallback.startsWith("Execution completed.")
  ) {
    return [];
  }

  return [
    {
      id: `preview-output-${detail.task.id}`,
      kind: "output",
      text: fallback,
    },
  ];
}

function buildStream(
  detail: ApiAgentTaskDetail,
  streamError: string | null,
  fallbackContent: string | null | undefined,
): StreamItem[] {
  const approval = getPendingApproval(detail);
  const finalOutputItems = buildOutputItems(detail, fallbackContent);
  const hasFinalOutput = finalOutputItems.length > 0;
  const timelineItems = hasFinalOutput
    ? buildTimelineItems(detail).filter((item) => item.kind !== "output")
    : buildTimelineItems(detail);
  const hasTimelineError = timelineItems.some((item) => item.kind === "meta" && item.tone === "danger");
  const statusItems = hasTimelineError ? [] : buildStatusItems(streamError);
  const metaItems = mergeOutputRows([...buildApprovalItems(approval), ...timelineItems, ...statusItems]);
  const shouldAppendOutput = detail.task.status === "completed" || metaItems.length === 0;
  const items = mergeOutputRows([
    ...metaItems,
    ...(shouldAppendOutput && finalOutputItems.length > 0 ? finalOutputItems : []),
  ]);

  return normalizeHistoricalMetaItems(
    markActiveMetaItem(appendCurrentProcessItem(items, detail), detail),
    detail,
  );
}

function toneClassName(tone: StreamTone = "default") {
  switch (tone) {
    case "success":
      return "text-foreground/60";
    case "warning":
      return "text-foreground/50";
    case "danger":
      return "text-destructive/70";
    default:
      return "text-foreground/42";
  }
}

function getActiveMetaTextStyle(): CSSProperties {
  return {
    backgroundImage:
      "linear-gradient(90deg, rgba(15,23,42,0.26) 0%, rgba(15,23,42,0.52) 24%, rgba(15,23,42,0.82) 48%, rgba(15,23,42,0.48) 72%, rgba(15,23,42,0.26) 100%)",
    backgroundSize: "220% 100%",
    backgroundClip: "text",
    WebkitBackgroundClip: "text",
    color: "transparent",
    WebkitTextFillColor: "transparent",
    animation: "agentMetaTextFlow 2.35s linear infinite",
  };
}

export function DesktopAgentTaskMetaLine({
  text,
  tone = "default",
  active = false,
  subtext,
}: {
  text: string;
  tone?: StreamTone;
  active?: boolean;
  subtext?: string | null;
}) {
  return (
    <div
      className={cn(
        "py-0.5 text-sm leading-6",
        toneClassName(tone),
      )}
    >
      <span className="relative flex items-start gap-2">
        <span
          aria-hidden="true"
          className="mt-[8px] h-1.5 w-1.5 shrink-0 rounded-full bg-current"
          style={{
            opacity: active ? 0.56 : 0.2,
            animation: active ? "agentMetaDotPulse 1.35s ease-in-out infinite" : undefined,
          }}
        />
        <span className="min-w-0">
          <span className="mr-2 opacity-24">{active ? ">" : "·"}</span>
          <span style={active ? getActiveMetaTextStyle() : undefined}>
            {text}
          </span>
          {subtext ? <span className="text-foreground opacity-32"> · {subtext}</span> : null}
          {active ? (
            <span
              aria-hidden="true"
              className="ml-2 inline-block h-[0.9em] w-px bg-current align-middle"
              style={{ animation: "agentMetaCursorPulse 1.05s ease-in-out infinite" }}
            />
          ) : null}
        </span>
      </span>
    </div>
  );
}

export function DesktopAgentTaskCard({
  messageId,
  taskId,
  fallbackContent,
}: {
  messageId: string;
  taskId: string;
  fallbackContent?: string;
}) {
  const [detail, setDetail] = useState<ApiAgentTaskDetail | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [busyAction, setBusyAction] = useState<"execute" | "retry" | "continue" | null>(null);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [isProcessExpanded, setIsProcessExpanded] = useState(false);
  const hasStreamedTextRef = useRef(false);
  const message = useChatStore((state) => state.messages.find((item) => item.id === messageId));

  const syncMessage = (nextDetail: ApiAgentTaskDetail) => {
    const currentMessage = useChatStore.getState().messages.find((message) => message.id === messageId);
    const nextSummary = buildTaskMessageSummary(nextDetail);
    const content =
      isLowSignalTaskSummary(nextSummary, nextDetail) && !isLowSignalTaskSummary(currentMessage?.content, nextDetail)
        ? currentMessage?.content ?? nextSummary
        : nextSummary;

    useChatStore.getState().updateMessage(messageId, {
      content,
      agentRun: buildTaskBackedAgentRun(nextDetail),
      citations: getTaskFinalResultCitations(nextDetail),
    });
  };

  const applyStreamingTextChunk = (chunk: string, currentDetail: ApiAgentTaskDetail) => {
    const nextChunk = chunk ?? "";
    if (!nextChunk) return;

    const store = useChatStore.getState();
    const currentMessage = store.messages.find((item) => item.id === messageId);
    const nextPulseKey = (currentMessage?.streamPulseKey ?? 0) + 1;
    const nextTail = Array.from(nextChunk).slice(-18).join("");
    const shouldReplace =
      !hasStreamedTextRef.current || isLowSignalTaskSummary(currentMessage?.content, currentDetail);

    if (shouldReplace) {
      store.updateMessage(messageId, {
        content: nextChunk,
        streamTail: nextTail,
        streamPulseKey: nextPulseKey,
      });
      hasStreamedTextRef.current = true;
      return;
    }

    store.appendMessageDelta(messageId, nextChunk);
    hasStreamedTextRef.current = true;
  };

  const resetStreamingText = () => {
    const store = useChatStore.getState();
    const currentMessage = store.messages.find((item) => item.id === messageId);
    store.updateMessage(messageId, {
      content: "",
      streamTail: "",
      streamPulseKey: (currentMessage?.streamPulseKey ?? 0) + 1,
    });
    hasStreamedTextRef.current = false;
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
        notifyError("Load failed", error instanceof Error ? error.message : "Unable to load task");
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
    if (!detail || detail.task.status !== "draft" || !autoExecutingTaskIds.has(detail.task.id)) {
      return;
    }

    const timer = window.setInterval(() => {
      void loadDetail(true);
    }, 1500);

    return () => {
      window.clearInterval(timer);
    };
  }, [detail?.task.id, detail?.task.status, taskId]);

  useEffect(() => {
    if (detail && detail.task.status !== "draft") {
      autoExecutingTaskIds.delete(detail.task.id);
    }
  }, [detail?.task.id, detail?.task.status]);

  useEffect(() => {
    if (!detail) return;

    if (detail.task.status === "completed") {
      setIsProcessExpanded(false);
      return;
    }

    setIsProcessExpanded(true);
  }, [detail?.task.id, detail?.task.status]);

  useEffect(() => {
    if (!detail || !detail.task.autoStart || detail.task.status !== "draft") return;
    if (autoExecutingTaskIds.has(detail.task.id) || busyAction !== null) return;
    autoExecutingTaskIds.add(detail.task.id);
    void runExecutionAction("execute", () => api.agentTasks.execute(detail.task.id));
  }, [detail, busyAction]);

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
              useChatStore.getState().updateMessage(messageId, {
                content: event.content,
                citations: event.citations,
              });
              hasStreamedTextRef.current = true;
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
                  artifacts: [artifact, ...current.artifacts.filter((item) => item.id !== artifact.id)],
                };
              });
              return;
            }

            const liveEvent = toLiveEvent(detail.task.id, event);
            if (liveEvent) {
              if (
                liveEvent.type === "execution_event" &&
                (getExecutionEventType(liveEvent) === "text" ||
                  getExecutionEventType(liveEvent) === "text_delta") &&
                typeof liveEvent.content === "string"
              ) {
                applyStreamingTextChunk(liveEvent.content, detail);
              }
              if (
                liveEvent.type === "execution_event" &&
                getExecutionEventType(liveEvent) === "text_reset"
              ) {
                resetStreamingText();
              }
              setDetail((current) => (current ? mergeExecutionEvent(current, liveEvent) : current));
              return;
            }

            if (event.type === "done") {
              await loadDetail(true);
            }
          },
          onError: (message) => {
            setStreamError(extractErrorMessage(message));
          },
        },
        {
          response: await responseFactory(),
          action,
        },
      );

      const refreshed = await loadDetail(true);
      if (refreshed) setDetail(refreshed);
    } catch (error) {
      const message = extractErrorMessage(error);
      setStreamError(message);
      notifyError("Run failed", message);
      const refreshed = await loadDetail(true);
      if (refreshed) setDetail(refreshed);
    } finally {
      setBusyAction(null);
    }
  };

  const stream = useMemo(
    () => (detail ? buildStream(detail, streamError, fallbackContent) : []),
    [detail, fallbackContent, streamError],
  );
  const processItems = stream.filter((item) => item.kind === "meta");
  const outputItems = stream.filter((item) => item.kind === "output");
  const toolCount =
    detail?.events.filter(
      (event) =>
        event.type === "execution_event" && getExecutionEventType(event) === "tool_start",
    ).length ?? 0;
  const finalCitations = detail ? getTaskFinalResultCitations(detail) : undefined;
  const loadingFallbackContent = sanitizeDisplayContent(message?.content ?? fallbackContent ?? "").trim();
  const shouldRenderLoadingFallback = !isLowSignalFallbackOutput(loadingFallbackContent);
  const loadingTaskStatus = message?.agentRun?.taskStatus;
  const hasProcess = processItems.length > 0;
  const canCollapseProcess = detail?.task.status === "completed" && hasProcess;
  const showProcess = hasProcess && (!canCollapseProcess || isProcessExpanded);
  const processToggleLabel = toolCount > 0 ? `Process · ${toolCount} tools` : "Process";

  if (isLoading && !detail) {
    if (shouldRenderLoadingFallback) {
      return (
        <section className="mt-0 px-1 pt-0 pb-1">
          <div className="space-y-2.5">
            <div className="text-sm leading-6 text-foreground">
              <DesktopMarkdownMessage content={loadingFallbackContent} />
              <DesktopCitationList citations={message?.citations} content={loadingFallbackContent} />
            </div>
          </div>
        </section>
      );
    }

    if (loadingTaskStatus && ["completed", "failed", "cancelled"].includes(loadingTaskStatus)) {
      return null;
    }

    return (
      <section className="mt-0 px-1 pt-0 pb-1">
        <DesktopAgentTaskMetaLine text="Thinking" active />
      </section>
    );
  }

  if (!detail) return null;

  return (
    <section className="mt-0 px-1 pt-0 pb-1">
      <style>{`
        @keyframes agentMetaTextFlow {
          0% { background-position: 130% 50%; text-shadow: 0 0 0 rgba(15,23,42,0); }
          50% { text-shadow: 0 0 8px rgba(15,23,42,0.08); }
          100% { background-position: -30% 50%; text-shadow: 0 0 0 rgba(15,23,42,0); }
        }
        @keyframes agentMetaDotPulse {
          0%, 100% { transform: scale(0.9); opacity: 0.35; }
          50% { transform: scale(1.05); opacity: 0.78; }
        }
        @keyframes agentMetaCursorPulse {
          0%, 100% { opacity: 0.18; transform: scaleY(0.92); }
          50% { opacity: 0.55; transform: scaleY(1); }
        }
      `}</style>
      <div className="space-y-2.5">
        {canCollapseProcess ? (
          <button
            type="button"
            onClick={() => setIsProcessExpanded((current) => !current)}
            className="flex items-center gap-2 py-0.5 text-sm leading-6 text-foreground/42 transition-colors hover:text-foreground/58"
          >
            <span
              aria-hidden="true"
              className="inline-block text-[10px] opacity-42 transition-transform"
              style={{ transform: isProcessExpanded ? "rotate(90deg)" : "rotate(0deg)" }}
            >
              ▶
            </span>
            <span>{processToggleLabel}</span>
          </button>
        ) : null}
        {showProcess ? (
          <div className="space-y-0.5">
            {processItems.map((item) => (
              <DesktopAgentTaskMetaLine
                key={item.id}
                text={item.text}
                tone={item.tone}
                active={item.active}
                subtext={item.subtext}
              />
            ))}
          </div>
        ) : null}
        {outputItems.map((item) => (
          <div
            key={item.id}
            className={cn(
              "text-sm leading-6 text-foreground",
              (showProcess || canCollapseProcess) && "pt-1",
            )}
          >
            {item.streaming ? (
              <DesktopStreamingMarkdownMessage
                content={item.text}
                tailLength={message?.streamTail?.length ?? 0}
                pulseKey={message?.streamPulseKey ?? 0}
              />
            ) : (
              <DesktopMarkdownMessage content={item.text} />
            )}
            {item.id === `final-output-${detail.task.id}` ? (
              <DesktopCitationList citations={finalCitations} content={item.text} />
            ) : null}
          </div>
        ))}
      </div>
    </section>
  );
}
