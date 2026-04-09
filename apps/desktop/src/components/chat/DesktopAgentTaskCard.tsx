import { type CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import { cn } from "ui";
import {
  formatStructuredAgentError,
  normalizeAgentDisplayText,
} from "../../lib/agentErrorDisplay";
import { getAgentRuntimeIssueLabel } from "../../lib/i18n/agent";
import { streamAgentTaskExecution, type AgentTaskStreamEvent } from "../../lib/agentTaskStream";
import { resolveAgentDisplayOutput } from "../../lib/agentOutput";
import { sanitizeDisplayContent } from "../../lib/citations";
import { notifyError } from "../../lib/notify";
import { createServerApi } from "../../lib/serverApi";
import { useChatStore } from "../../stores/chatStore";
import type {
  ApiAgentApproval,
  ApiAgentArtifact,
  ApiAgentRun,
  ApiProviderErrorKind,
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

type AgentEventMetadata = {
  eventType?: string | null;
  status?: string | null;
  stage?: string | null;
  errorCode?: ApiProviderErrorKind;
  retryable?: boolean;
  rawError?: string | null;
  approvalType?: string | null;
  live?: boolean;
};

function extractErrorMessage(error: unknown, fallback = "task failed") {
  if (typeof error === "string") return error.trim() || fallback;
  if (error instanceof Error) return error.message.trim() || fallback;
  return fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getEventMetadata(event: ApiAgentTaskEvent): AgentEventMetadata {
  if (!isRecord(event.metadata)) return {};
  return {
    eventType: typeof event.metadata.eventType === "string" ? event.metadata.eventType : null,
    status: typeof event.metadata.status === "string" ? event.metadata.status : null,
    stage: typeof event.metadata.stage === "string" ? event.metadata.stage : null,
    errorCode: typeof event.metadata.errorCode === "string" ? (event.metadata.errorCode as ApiProviderErrorKind) : undefined,
    retryable: typeof event.metadata.retryable === "boolean" ? event.metadata.retryable : undefined,
    rawError: typeof event.metadata.rawError === "string" ? event.metadata.rawError : null,
    approvalType: typeof event.metadata.approvalType === "string" ? event.metadata.approvalType : null,
    live: Boolean(event.metadata.live),
  };
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
  return getEventMetadata(event).eventType ?? null;
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
  const normalized = normalizeAgentDisplayText(content);
  if (!normalized) return null;
  return normalized.length > limit ? `${normalized.slice(0, limit - 3)}...` : normalized;
}

function normalizeProcessText(content: string | null | undefined, metadata?: AgentEventMetadata) {
  const normalized = normalizeAgentDisplayText(content, metadata);
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
  const subtext = summarizeProcessDetail(content, 84);
  return {
    text: presentActionLabel(label),
    subtext: subtext === "ok" ? null : subtext,
  };
}

function describeTaskStatus(status: ApiAgentTaskDetail["task"]["status"]) {
  switch (status) {
    case "draft":
      return { text: "Thinking", tone: "default" as const };
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
  return getEventMetadata(event).status ?? null;
}

function getApprovalEventMeta(event: ApiAgentTaskEvent) {
  const metadata = getEventMetadata(event);
  return {
    type: metadata.approvalType ?? null,
    status: metadata.status ?? null,
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

/**
 * Returns the *real* user-visible summary for this task, or an empty string
 * when no real content is available yet.
 *
 * Real sources, in priority order:
 *   1. final_result artifact content (when the task has completed)
 *   2. server-provided insight.previewText
 *
 * When neither is available we return "" — the caller is expected to render
 * structured task state (status badge, plan steps, approval panel) instead
 * of inventing a placeholder string.
 */
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

  return preview;
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

function isDraftAutoStartRun(run: ApiAgentRun | null | undefined, taskId: string) {
  return Boolean(run?.taskId === taskId && run.autoStart && run.taskStatus === "draft");
}

/**
 * True when the message currently has no real assistant text. We treat this
 * as "the streaming layer should freely overwrite content with the next real
 * chunk", because there is nothing real to preserve.
 */
function hasRealMessageContent(text: string | null | undefined) {
  return (text ?? "").trim().length > 0;
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
      const metadata = getEventMetadata(event);
      const text = summarizeProcessDetail(normalizeProcessText(event.content, metadata));
      // Drop the row entirely when neither raw content nor a structured
      // errorCode is available — never invent a placeholder string.
      if (!text) continue;
      items.push({
        id: event.id,
        kind: "meta",
        text,
        tone: "danger",
      });
      continue;
    }

    if (event.type !== "execution_event") continue;

    const eventType = getExecutionEventType(event);
    if (eventType === "thought") {
      const text = normalizeProcessText(event.content, getEventMetadata(event));
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
      if ((event.content ?? "").trim().toLowerCase() === "ok" && !result.subtext) {
        continue;
      }
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
      const text = normalizeProcessText(event.content, getEventMetadata(event));
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
        const metadata = getEventMetadata(event);
        items.push({
          id: event.id,
          kind: "meta",
          label: statusValue === "failed" || statusValue === "cancelled" ? "error" : "thinking",
          text: formatStructuredAgentError(metadata.errorCode, metadata.retryable) || status.text,
          tone: status.tone,
        });
      }
      continue;
    }

    if (event.type === "execution_event") {
      items.push(...buildExecutionItems([event]));
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
      const metadata = getEventMetadata(event);
      const text = summarizeProcessDetail(normalizeProcessText(event.content, metadata));
      // Same policy as buildExecutionItems: skip rather than fabricate.
      if (!text) continue;
      items.push({
        id: event.id,
        kind: "meta",
        label: "error",
        text,
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

function buildStatusItems(
  streamError: { message: string; runtimeIssue?: string | null } | null,
): StreamItem[] {
  const items: StreamItem[] = [];

  if (!streamError) return items;

  // Priority order:
  //   1. Server-supplied structured runtime issue (live_search_failed, etc.)
  //      → look up the localized label from the i18n dictionary.
  //   2. Otherwise, run the raw message through normalizeAgentDisplayText,
  //      which will trim/sanitize and (when applicable) translate via the
  //      structured errorCode dictionary.
  //   3. Final fallback: the raw message string as-is. We never invent a
  //      Chinese placeholder.
  const runtimeIssueLabel = getAgentRuntimeIssueLabel(streamError.runtimeIssue);
  const text =
    runtimeIssueLabel ||
    normalizeAgentDisplayText(streamError.message) ||
    streamError.message;

  items.push({
    id: "stream-error",
    kind: "meta",
    label: "error",
    text,
    tone: "danger",
  });

  return items;
}

function isTerminalTaskStatus(status: ApiAgentTaskDetail["task"]["status"]) {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function mergeAgentOutputSnapshot(current: string, incoming: string) {
  const base = current.trim();
  const next = incoming.trim();

  if (!next) return current;
  if (!base) return incoming;
  if (incoming === current) return current;
  if (incoming.startsWith(current)) return incoming;
  if (current.startsWith(incoming)) return current;
  return incoming;
}

function appendCurrentProcessItem(items: StreamItem[], detail: ApiAgentTaskDetail) {
  if (!["draft", "planning", "running", "awaiting_approval"].includes(detail.task.status)) {
    return items;
  }

  if (detail.task.status === "draft" && !detail.task.autoStart) {
    return items;
  }

  const hasLiveOutput = items.some((item) => item.kind === "output");
  if (hasLiveOutput) {
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
  const isTerminal = isTerminalTaskStatus(detail.task.status);
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

  // Terminal state with no real artifact and no real execution text. Only
  // surface the fallback caller passed in if it carries actual content; we
  // never invent a placeholder string here.
  const fallback = sanitizeDisplayContent(fallbackContent ?? "").trim();
  if (!fallback) return [];

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
  streamError: { message: string; runtimeIssue?: string | null } | null,
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
          <span className={cn("mr-2", active ? "opacity-38" : "opacity-24")}>·</span>
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
  const [streamError, setStreamError] = useState<{
    message: string;
    runtimeIssue?: string | null;
  } | null>(null);
  const [isProcessExpanded, setIsProcessExpanded] = useState(false);
  const [isExecutionStreaming, setIsExecutionStreaming] = useState(false);
  const [liveOutputText, setLiveOutputText] = useState("");
  const [liveOutputPulseKey, setLiveOutputPulseKey] = useState(0);
  const [liveOutputCitations, setLiveOutputCitations] = useState<ApiCitation[] | undefined>(undefined);
  const hasStreamedTextRef = useRef(false);
  const detailRef = useRef<ApiAgentTaskDetail | null>(null);
  const liveOutputTextRef = useRef("");
  const message = useChatStore((state) => state.messages.find((item) => item.id === messageId));
  const canAutoExecuteFromMessage = isDraftAutoStartRun(message?.agentRun, taskId);

  const syncMessage = (nextDetail: ApiAgentTaskDetail) => {
    const currentMessage = useChatStore.getState().messages.find((message) => message.id === messageId);
    const nextSummary = buildTaskMessageSummary(nextDetail);
    const currentContent = currentMessage?.content ?? "";
    const isTerminal = isTerminalTaskStatus(nextDetail.task.status);

    // Decision rules (no string-equality heuristics):
    //   1. If the task has reached a terminal state, always trust the latest
    //      summary from the task detail — this is the canonical final output.
    //   2. While still running, if we already have real content (either from
    //      a live stream or a previous detail), keep it instead of letting
    //      a momentarily-empty summary blank out the bubble.
    //   3. Otherwise, take whatever the new summary is (may be empty — the
    //      UI will fall back to structured task state).
    let content: string;
    if (isTerminal) {
      content = nextSummary;
    } else if (hasRealMessageContent(currentContent) && !nextSummary) {
      content = currentContent;
    } else {
      content = nextSummary;
    }

    useChatStore.getState().updateMessage(messageId, {
      content,
      agentRun: buildTaskBackedAgentRun(nextDetail),
      citations: getTaskFinalResultCitations(nextDetail),
    });
  };

  const setLiveOutputSnapshot = (nextText: string, citations?: ApiCitation[]) => {
    liveOutputTextRef.current = nextText;
    setLiveOutputText(nextText);
    setLiveOutputPulseKey((current) => current + 1);
    if (citations) {
      setLiveOutputCitations(citations);
    }
  };

  const appendLiveOutputDelta = (chunk: string) => {
    const nextChunk = chunk ?? "";
    if (!nextChunk) return;

    const nextText = `${liveOutputTextRef.current}${nextChunk}`;
    setLiveOutputSnapshot(nextText);
  };

  const mergeLiveOutputSnapshot = (text: string, citations?: ApiCitation[]) => {
    const merged = mergeAgentOutputSnapshot(liveOutputTextRef.current, text);
    if (merged === liveOutputTextRef.current) {
      if (citations) {
        setLiveOutputCitations(citations);
      }
      return;
    }
    setLiveOutputSnapshot(merged, citations);
  };

  const applyStreamingTextChunk = (
    chunk: string,
    _currentDetail: ApiAgentTaskDetail | null,
    mode: "delta" | "snapshot" = "delta",
  ) => {
    const nextChunk = chunk ?? "";
    if (!nextChunk) return;

    const store = useChatStore.getState();
    const currentMessage = store.messages.find((item) => item.id === messageId);
    // Replace whenever we have not yet appended any real streaming text, or
    // when the current message has no real content to preserve. There is no
    // longer any "low signal" placeholder to detect — server-side fabricated
    // summaries have been removed.
    const shouldReplace =
      !hasStreamedTextRef.current || !hasRealMessageContent(currentMessage?.content);
    const nextText =
      mode === "delta"
        ? `${currentMessage?.content ?? ""}${nextChunk}`
        : mergeAgentOutputSnapshot(currentMessage?.content ?? "", nextChunk);
    const nextPulseKey = (currentMessage?.streamPulseKey ?? 0) + 1;
    const nextTail = Array.from(nextText).slice(-18).join("");

    if (mode === "delta") {
      appendLiveOutputDelta(nextChunk);
    } else {
      mergeLiveOutputSnapshot(nextChunk);
    }

    if (shouldReplace) {
      store.updateMessage(messageId, {
        content: mode === "delta" ? nextChunk : nextText,
        streamTail: nextTail,
        streamPulseKey: nextPulseKey,
      });
      hasStreamedTextRef.current = true;
      return;
    }

    if (mode === "delta") {
      store.appendMessageDelta(messageId, nextChunk);
    } else {
      store.updateMessage(messageId, {
        content: nextText,
        streamTail: nextTail,
        streamPulseKey: nextPulseKey,
      });
    }
    hasStreamedTextRef.current = true;
  };

  const resetStreamingText = () => {
    liveOutputTextRef.current = "";
    setLiveOutputText("");
    setLiveOutputPulseKey((current) => current + 1);
    setLiveOutputCitations(undefined);
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
      detailRef.current = nextDetail;
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
    liveOutputTextRef.current = "";
    setLiveOutputText("");
    setLiveOutputPulseKey(0);
    setLiveOutputCitations(undefined);
    hasStreamedTextRef.current = false;
    detailRef.current = null;
  }, [taskId]);

  useEffect(() => {
    detailRef.current = detail;
  }, [detail]);

  useEffect(() => {
    if (
      !detail ||
      isExecutionStreaming ||
      (detail.task.status !== "running" && detail.task.status !== "awaiting_approval")
    ) {
      return;
    }

    const timer = window.setInterval(() => {
      void loadDetail(true);
    }, 4000);

    return () => {
      window.clearInterval(timer);
    };
  }, [detail?.task.status, isExecutionStreaming, taskId]);

  useEffect(() => {
    if (
      isExecutionStreaming ||
      !autoExecutingTaskIds.has(detail?.task.id ?? taskId) ||
      (detail ? detail.task.status !== "draft" : false)
    ) {
      return;
    }

    const timer = window.setInterval(() => {
      void loadDetail(true);
    }, 1500);

    return () => {
      window.clearInterval(timer);
    };
  }, [detail?.task.id, detail?.task.status, isExecutionStreaming, taskId]);

  useEffect(() => {
    if (detail && detail.task.status !== "draft") {
      autoExecutingTaskIds.delete(detail.task.id);
      return;
    }

    if (
      !detail &&
      message?.agentRun?.taskId === taskId &&
      message.agentRun.taskStatus &&
      message.agentRun.taskStatus !== "draft"
    ) {
      autoExecutingTaskIds.delete(taskId);
    }
  }, [detail?.task.id, detail?.task.status, message?.agentRun?.taskId, message?.agentRun?.taskStatus, taskId]);

  useEffect(() => {
    if (!detail) return;

    if (detail.task.status === "completed") {
      setIsProcessExpanded(false);
      return;
    }

    setIsProcessExpanded(true);
  }, [detail?.task.id, detail?.task.status]);

  useEffect(() => {
    const canAutoExecuteFromDetail = Boolean(
      detail && detail.task.autoStart && detail.task.status === "draft",
    );
    const executionTaskId = detail?.task.id ?? (canAutoExecuteFromMessage ? taskId : null);

    if (!executionTaskId || (!canAutoExecuteFromDetail && !canAutoExecuteFromMessage)) return;
    if (autoExecutingTaskIds.has(executionTaskId) || busyAction !== null || isExecutionStreaming) return;

    autoExecutingTaskIds.add(executionTaskId);
    void runExecutionAction("execute", () => api.agentTasks.execute(executionTaskId), executionTaskId);
  }, [
    detail?.task.id,
    detail?.task.autoStart,
    detail?.task.status,
    canAutoExecuteFromMessage,
    busyAction,
    isExecutionStreaming,
    taskId,
  ]);

  const runExecutionAction = async (
    action: "execute" | "retry" | "continue",
    responseFactory: () => Promise<Response>,
    executionTaskId = detailRef.current?.task.id ?? taskId,
  ) => {
    setBusyAction(action);
    setIsExecutionStreaming(true);
    setStreamError(null);
    let refreshedAfterDone = false;

    try {
      await streamAgentTaskExecution(
        executionTaskId,
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
              mergeLiveOutputSnapshot(event.content, event.citations);
              const store = useChatStore.getState();
              const currentMessage = store.messages.find((item) => item.id === messageId);
              store.updateMessage(messageId, {
                content: mergeAgentOutputSnapshot(currentMessage?.content ?? "", event.content),
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

            const liveEvent = toLiveEvent(executionTaskId, event);
            if (liveEvent) {
              const currentDetail = detailRef.current;
              if (
                liveEvent.type === "execution_event" &&
                (getExecutionEventType(liveEvent) === "text" ||
                  getExecutionEventType(liveEvent) === "text_delta") &&
                typeof liveEvent.content === "string"
              ) {
                applyStreamingTextChunk(
                  liveEvent.content,
                  currentDetail,
                  getExecutionEventType(liveEvent) === "text_delta" ? "delta" : "snapshot",
                );
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
              const refreshed = await loadDetail(true);
              if (refreshed) {
                setDetail(refreshed);
              }
              refreshedAfterDone = true;
            }
          },
          onError: (message, metadata) => {
            const runtimeIssue =
              isRecord(metadata) && typeof metadata.runtimeIssue === "string"
                ? metadata.runtimeIssue
                : null;
            setStreamError({
              message: extractErrorMessage(message),
              runtimeIssue,
            });
          },
        },
        {
          response: await responseFactory(),
          action,
        },
      );

      if (!refreshedAfterDone) {
        const refreshed = await loadDetail(true);
        if (refreshed) setDetail(refreshed);
      }
    } catch (error) {
      const message = extractErrorMessage(error);
      setStreamError({ message });
      notifyError("Run failed", message);
      const refreshed = await loadDetail(true);
      if (refreshed) setDetail(refreshed);
    } finally {
      setIsExecutionStreaming(false);
      setBusyAction(null);
    }
  };

  const stream = useMemo(
    () => (detail ? buildStream(detail, streamError, fallbackContent) : []),
    [detail, fallbackContent, streamError],
  );
  const isTerminal = detail ? isTerminalTaskStatus(detail.task.status) : false;
  const processItems = stream.filter((item) => item.kind === "meta");
  const outputItems = stream.filter((item) => item.kind === "output");
  const toolCount =
    detail?.events.filter(
      (event) =>
        event.type === "execution_event" && getExecutionEventType(event) === "tool_start",
    ).length ?? 0;
  const finalCitations = detail ? getTaskFinalResultCitations(detail) : undefined;
  const loadingFallbackContent = sanitizeDisplayContent(message?.content ?? fallbackContent ?? "").trim();
  const shouldRenderLoadingFallback = hasRealMessageContent(loadingFallbackContent);
  const loadingTaskStatus = message?.agentRun?.taskStatus;
  const hasProcess = processItems.length > 0;
  const canCollapseProcess = detail?.task.status === "completed" && hasProcess;
  const showProcess = hasProcess && (!canCollapseProcess || isProcessExpanded);
  const fallbackProcessText =
    detail && !showProcess && outputItems.length === 0 && !isTerminal
      ? message?.agentRun?.summary?.trim() || describeTaskStatus(detail.task.status).text
      : null;
  const processToggleLabel =
    toolCount > 0 ? `Process · ${toolCount} ${toolCount === 1 ? "tool" : "tools"}` : "Process";
  const detailOutputText = outputItems.map((item) => item.text).join("\n\n").trim();
  const displayOutput = resolveAgentDisplayOutput({
    liveOutputText,
    messageContent: message?.content,
    detailOutputText,
    fallbackContent,
    liveOutputCitations,
    messageCitations: message?.citations,
    finalCitations,
    isTerminal,
    isExecutionStreaming,
  });

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
        {fallbackProcessText ? <DesktopAgentTaskMetaLine text={fallbackProcessText} active /> : null}
        {displayOutput ? (
          <div
            key={`agent-output-${detail.task.id}`}
            className={cn(
              "text-sm leading-6",
              isTerminal ? "text-foreground" : "text-foreground/58",
              isTerminal && (showProcess || canCollapseProcess) && "pt-1",
            )}
          >
            {displayOutput.streaming ? (
              <DesktopStreamingMarkdownMessage
                content={displayOutput.text}
                tailLength={Array.from(liveOutputText || displayOutput.text).length}
                pulseKey={liveOutputPulseKey}
              />
            ) : (
              <DesktopMarkdownMessage content={displayOutput.text} />
            )}
            <DesktopCitationList
              citations={displayOutput.citations}
              content={displayOutput.text}
            />
          </div>
        ) : null}
      </div>
    </section>
  );
}
