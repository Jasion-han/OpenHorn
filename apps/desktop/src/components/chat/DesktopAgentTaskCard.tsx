import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cn } from "ui";
import { respondAgentApproval } from "../../lib/agentTaskActions";
import { streamAgentTaskExecution, type AgentTaskStreamEvent } from "../../lib/agentTaskStream";
import { resolveAgentDisplayOutput } from "../../lib/agentOutput";
import { sanitizeDisplayContent } from "../../lib/citations";
import { notifyError } from "../../lib/notify";
import { createServerApi } from "../../lib/serverApi";
import { useAgentTaskPolling } from "../../hooks/useAgentTaskPolling";
import { useChatStore } from "../../stores/chatStore";
import type {
  ApiAgentApproval,
  ApiAgentArtifact,
  ApiAgentTaskDetail,
  ApiAgentTaskStatus,
  ApiCitation,
} from "../../types/chat";
import {
  buildStream,
  buildTaskMessageSummary,
  buildTaskBackedAgentRun,
  getTaskFinalResultCitations,
  getExecutionEventType,
  isTerminalTaskStatus,
  isDraftAutoStartRun,
  hasRealMessageContent,
  mergeExecutionEvent,
  toLiveEvent,
  mergeAgentOutputSnapshot,
} from "../../lib/agentTaskStreamBuilder";
import { describeTaskStatus, extractErrorMessage } from "../../lib/agentTaskPresenter";
import { DesktopAgentTaskMetaLine } from "./DesktopAgentTaskMetaLine";
import { DesktopAgentPlanPanel } from "./DesktopAgentPlanPanel";
import { DesktopAgentToolApprovalPanel } from "./DesktopAgentToolApprovalPanel";
import { DesktopCitationList } from "./DesktopCitationList";
import { DesktopMarkdownMessage } from "./DesktopMarkdownMessage";
import { DesktopStreamingMarkdownMessage } from "./DesktopStreamingMarkdownMessage";

export { DesktopAgentTaskMetaLine } from "./DesktopAgentTaskMetaLine";

const api = createServerApi();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
  const [approvalSubmitting, setApprovalSubmitting] = useState(false);
  const [approvalError, setApprovalError] = useState<string | null>(null);
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

  // Polling + auto-execute are centralised in a single hook so the
  // mutual-exclusion rules (stream running → skip polling; draft +
  // autoStart → fast poll then fire once) live in one place instead
  // of being spread across five useEffects that can drift apart.
  const runExecutionActionRef = useRef<
    (action: "execute" | "retry" | "continue", factory: () => Promise<Response>, id?: string) => Promise<void>
  >(undefined as unknown as (action: "execute" | "retry" | "continue", factory: () => Promise<Response>, id?: string) => Promise<void>);
  // runExecutionActionRef is assigned right after runExecutionAction
  // is defined (see below). We use a ref so the polling hook's
  // onAutoExecute callback stays stable across renders.
  const handleAutoExecute = useCallback(
    (executionTaskId: string) => {
      void runExecutionActionRef.current?.(
        "execute",
        () => api.agentTasks.execute(executionTaskId),
        executionTaskId,
      );
    },
    [],
  );
  const loadDetailSilent = useCallback(() => loadDetail(true) as unknown as Promise<void>, [taskId]);
  useAgentTaskPolling({
    taskId,
    detail,
    isExecutionStreaming,
    busyAction,
    canAutoExecuteFromMessage,
    loadDetail: loadDetailSilent,
    onAutoExecute: handleAutoExecute,
  });

  useEffect(() => {
    if (!detail) return;

    if (detail.task.status === "completed") {
      setIsProcessExpanded(false);
      return;
    }

    setIsProcessExpanded(true);
  }, [detail?.task.id, detail?.task.status]);

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
      if (refreshed) {
        // If the server-side task is still running (e.g. the SSE connection
        // dropped but the server hasn't timed out yet), mark it as failed
        // locally so the UI doesn't stay stuck on "Working".
        const nonTerminal = ["draft", "planned", "running", "pending_approval"];
        if (nonTerminal.includes(refreshed.task.status)) {
          refreshed.task.status = "failed" as ApiAgentTaskStatus;
        }
        setDetail(refreshed);
      }
    } finally {
      setIsExecutionStreaming(false);
      setBusyAction(null);
    }
  };
  runExecutionActionRef.current = runExecutionAction;

  const handleApprovalResponse = async (
    approval: ApiAgentApproval,
    status: "approved" | "rejected",
  ) => {
    if (approvalSubmitting) return;
    setApprovalSubmitting(true);
    setApprovalError(null);

    const result = await respondAgentApproval({
      api: {
        respondApproval: (id, data) => api.agentTasks.respondApproval(id, data),
        cancel: (id) => api.agentTasks.cancel(id),
      },
      approvalId: approval.id,
      approvalType: approval.type,
      status,
      onPlanApprovalAccepted: async () => {
        // Server resets the task to "draft" after a plan is approved.
        // Kick off the next execution run so the user does not have to.
        const executionTaskId = detailRef.current?.task.id ?? taskId;
        await runExecutionAction(
          "execute",
          () => api.agentTasks.execute(executionTaskId),
          executionTaskId,
        );
      },
    });

    setApprovalSubmitting(false);
    if (result.ok) {
      // Pick up server-side state changes (status, plan step transitions,
      // approval row resolution).
      const refreshed = await loadDetail(true);
      if (refreshed) setDetail(refreshed);
    } else {
      setApprovalError(result.error);
      notifyError("Approval failed", result.error);
    }
  };

  const stream = useMemo(
    () => (detail ? buildStream(detail, streamError, fallbackContent) : []),
    [detail, fallbackContent, streamError],
  );
  const pendingPlanApproval = useMemo(() => {
    if (!detail) return null;
    return (
      detail.approvals.find(
        (approval) => approval.status === "pending" && approval.type === "plan_approval",
      ) ?? null
    );
  }, [detail]);
  const pendingToolApproval = useMemo(() => {
    if (!detail) return null;
    return (
      detail.approvals.find(
        (approval) => approval.status === "pending" && approval.type === "tool_approval",
      ) ?? null
    );
  }, [detail]);
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
        {pendingPlanApproval ? (
          <DesktopAgentPlanPanel
            planSteps={detail.planSteps}
            pendingApproval={pendingPlanApproval}
            submitting={approvalSubmitting}
            submitError={approvalError}
            onApprove={(approvalId) => {
              const target = detail.approvals.find((item) => item.id === approvalId);
              if (target) void handleApprovalResponse(target, "approved");
            }}
            onReject={(approvalId) => {
              const target = detail.approvals.find((item) => item.id === approvalId);
              if (target) void handleApprovalResponse(target, "rejected");
            }}
          />
        ) : null}
        {pendingToolApproval ? (
          <DesktopAgentToolApprovalPanel
            approval={pendingToolApproval}
            submitting={approvalSubmitting}
            submitError={approvalError}
            onApprove={(approvalId) => {
              const target = detail.approvals.find((item) => item.id === approvalId);
              if (target) void handleApprovalResponse(target, "approved");
            }}
            onReject={(approvalId) => {
              const target = detail.approvals.find((item) => item.id === approvalId);
              if (target) void handleApprovalResponse(target, "rejected");
            }}
          />
        ) : null}
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
