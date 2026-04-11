import {
  formatStructuredAgentError,
  normalizeAgentDisplayText,
} from "./agentErrorDisplay";
import { getAgentRuntimeIssueLabel } from "./i18n/agent";
import { sanitizeDisplayContent } from "./citations";
import type {
  ApiAgentApproval,
  ApiAgentArtifact,
  ApiAgentRun,
  ApiProviderErrorKind,
  ApiAgentTaskDetail,
  ApiAgentTaskEvent,
  ApiCitation,
} from "../types/chat";
import type { AgentTaskStreamEvent } from "./agentTaskStream";
import {
  actionLabel,
  simplifyToolName,
  prettifyToolName,
  describeToolStart,
  describeToolResult,
  describeTaskStatus,
  summarizeToolInput,
  summarizeProcessDetail,
  normalizeProcessText,
  summarizeApprovalToolInput,
  getToolApprovalPayload,
} from "./agentTaskPresenter";

export type StreamTone = "default" | "success" | "warning" | "danger";

export type StreamItem = {
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

export type AgentEventMetadata = {
  eventType?: string | null;
  status?: string | null;
  stage?: string | null;
  errorCode?: ApiProviderErrorKind;
  retryable?: boolean;
  rawError?: string | null;
  approvalType?: string | null;
  live?: boolean;
};

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

export function getExecutionEventType(event: ApiAgentTaskEvent) {
  return getEventMetadata(event).eventType ?? null;
}

export function getArtifactCitations(artifact: ApiAgentArtifact | null | undefined): ApiCitation[] | undefined {
  if (!artifact || !isRecord(artifact.metadata)) return undefined;
  const citations = artifact.metadata.citations;
  return Array.isArray(citations) ? (citations as ApiCitation[]) : undefined;
}

export function getTaskFinalResultArtifact(detail: ApiAgentTaskDetail) {
  return detail.artifacts.find((artifact) => artifact.type === "final_result") ?? null;
}

export function getTaskFinalResultCitations(detail: ApiAgentTaskDetail) {
  return getArtifactCitations(getTaskFinalResultArtifact(detail));
}

export function mergeOutputRows(items: StreamItem[]) {
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

export function buildExecutionItems(events: ApiAgentTaskEvent[]) {
  const items: StreamItem[] = [];
  let thoughtGroupCounter = 0;

  for (const event of events) {
    if (event.type === "error") {
      const metadata = getEventMetadata(event);
      const text = summarizeProcessDetail(normalizeProcessText(event.content, metadata));
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

    // text_reset is a no-op in the timeline.
    if (eventType === "text_reset") {
      continue;
    }

    // text_delta: merge consecutive deltas into a single thought row so the
    // user can see what the model is thinking between tool calls. A new
    // thought group starts after any non-text_delta event.
    if (eventType === "text_delta") {
      const text = normalizeProcessText(event.content, getEventMetadata(event));
      if (text) {
        const last = items.length > 0 ? items[items.length - 1] : null;
        if (last && last.mergeKey?.startsWith("streamed-thought-")) {
          items[items.length - 1] = { ...last, text: `${last.text}${text}` };
        } else {
          thoughtGroupCounter++;
          items.push({
            id: event.id,
            kind: "meta",
            label: "thinking",
            text,
            tone: "default",
            mergeKey: `streamed-thought-${thoughtGroupCounter}`,
          });
        }
      }
      continue;
    }

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

    // Final text output from the model
    if (eventType === "text") {
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

export function buildTimelineItems(detail: ApiAgentTaskDetail): StreamItem[] {
  const items: StreamItem[] = [];
  const events = [...detail.events].sort(
    (left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime(),
  );
  const hasExplicitErrorEvent = events.some((event) => event.type === "error");

  // Collect consecutive execution_events and pass them as a batch to
  // buildExecutionItems so that text_delta merging works across events.
  const flushExecBatch = (batch: ApiAgentTaskEvent[]) => {
    if (batch.length > 0) {
      items.push(...buildExecutionItems(batch));
      batch.length = 0;
    }
  };
  const execBatch: ApiAgentTaskEvent[] = [];

  for (const event of events) {
    if (event.type === "execution_event") {
      execBatch.push(event);
      continue;
    }

    // Non-execution event: flush any pending execution batch first.
    flushExecBatch(execBatch);

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

  // Flush any remaining execution events.
  flushExecBatch(execBatch);

  return mergeOutputRows(items);
}

export function buildApprovalItems(approval: ApiAgentApproval | null): StreamItem[] {
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

export function buildStatusItems(
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

export function isTerminalTaskStatus(status: ApiAgentTaskDetail["task"]["status"]) {
  return status === "completed" || status === "failed" || status === "cancelled";
}

export function mergeAgentOutputSnapshot(current: string, incoming: string) {
  const base = current.trim();
  const next = incoming.trim();

  if (!next) return current;
  if (!base) return incoming;
  if (incoming === current) return current;
  if (incoming.startsWith(current)) return incoming;
  if (current.startsWith(incoming)) return current;
  return incoming;
}

export function appendCurrentProcessItem(items: StreamItem[], detail: ApiAgentTaskDetail) {
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

export function markActiveMetaItem(items: StreamItem[], detail: ApiAgentTaskDetail) {
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

export function normalizeHistoricalMetaItems(items: StreamItem[], detail: ApiAgentTaskDetail) {
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

export function buildOutputItems(detail: ApiAgentTaskDetail, fallbackContent: string | null | undefined): StreamItem[] {
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

export function getPendingApproval(detail: ApiAgentTaskDetail): ApiAgentApproval | null {
  return detail.approvals.find((approval) => approval.status === "pending") ?? null;
}

export function mergeExecutionEvent(detail: ApiAgentTaskDetail, nextEvent: ApiAgentTaskEvent) {
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

export function toLiveEvent(taskId: string, event: AgentTaskStreamEvent): ApiAgentTaskEvent | null {
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
export function buildTaskMessageSummary(detail: ApiAgentTaskDetail) {
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

export function buildTaskBackedAgentRun(detail: ApiAgentTaskDetail): ApiAgentRun {
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

export function isDraftAutoStartRun(run: ApiAgentRun | null | undefined, taskId: string) {
  return Boolean(run?.taskId === taskId && run.autoStart && run.taskStatus === "draft");
}

/**
 * True when the message currently has no real assistant text. We treat this
 * as "the streaming layer should freely overwrite content with the next real
 * chunk", because there is nothing real to preserve.
 */
export function hasRealMessageContent(text: string | null | undefined) {
  return (text ?? "").trim().length > 0;
}

export function buildStream(
  detail: ApiAgentTaskDetail,
  streamError: { message: string; runtimeIssue?: string | null } | null,
  fallbackContent: string | null | undefined,
): StreamItem[] {
  const approval = getPendingApproval(detail);
  const allTimelineItems = buildTimelineItems(detail);
  // Keep output items out of the Process panel — they belong in the message body.
  const timelineItems = allTimelineItems.filter((item) => item.kind !== "output");
  const finalOutputItems = buildOutputItems(detail, fallbackContent);
  const hasTimelineError = timelineItems.some((item) => item.kind === "meta" && item.tone === "danger");
  const statusItems = hasTimelineError ? [] : buildStatusItems(streamError);
  const shouldAppendOutput = detail.task.status === "completed" || timelineItems.length === 0;
  const items = mergeOutputRows([
    ...buildApprovalItems(approval),
    ...timelineItems,
    ...statusItems,
    ...(shouldAppendOutput && finalOutputItems.length > 0 ? finalOutputItems : []),
  ]);

  return normalizeHistoricalMetaItems(
    markActiveMetaItem(appendCurrentProcessItem(items, detail), detail),
    detail,
  );
}
