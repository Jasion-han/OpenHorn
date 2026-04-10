import { useEffect, useRef } from "react";
import type { ApiAgentTaskDetail } from "../types/chat";

/**
 * Centralises the two polling intervals + auto-execute trigger that the
 * task card uses to stay in sync with the server when there is no live
 * SSE stream attached.
 *
 * Rules (all in one place now instead of scattered across three
 * independent useEffects):
 *
 *   1. While the live SSE stream is running (`isExecutionStreaming`),
 *      **no polling happens at all** — the stream already delivers
 *      every state change in real time.
 *
 *   2. When the task is active (`running` / `awaiting_approval`) but
 *      we are NOT streaming, we poll at a relaxed interval (4 s) to
 *      pick up status transitions that happened outside the desktop
 *      client (e.g. another tab, a server-side timeout, an approval
 *      posted from the web UI).
 *
 *   3. When a freshly-created task is in `draft` and auto-start is
 *      pending (registered in `autoExecutingTaskIds`), we poll at a
 *      faster interval (1.5 s) so the card detects when the server
 *      has finished planning and transitions to `running`.
 *
 *   4. Auto-execute fires once: when a draft + autoStart task is
 *      first detected, we call the `onAutoExecute(taskId)` callback.
 *      The callback is responsible for actually kicking off the
 *      execution SSE stream. We guard against double-fires through
 *      `autoExecutingTaskIds`.
 *
 * Callers still own all the state (`detail`, `isExecutionStreaming`,
 * `busyAction`, etc.) — this hook only reads them and schedules
 * side-effects through the provided callbacks.
 */

const ACTIVE_POLL_INTERVAL = 4_000;
const DRAFT_POLL_INTERVAL = 1_500;

/** Module-level set shared across all card instances. */
const autoExecutingTaskIds = new Set<string>();

export { autoExecutingTaskIds };

export interface UseAgentTaskPollingInput {
  taskId: string;
  detail: ApiAgentTaskDetail | null;
  isExecutionStreaming: boolean;
  busyAction: "execute" | "retry" | "continue" | null;
  /**
   * Whether the message-level agentRun flags indicate a draft+autoStart
   * condition even before the detail has been fetched.
   */
  canAutoExecuteFromMessage: boolean;

  /** Silently refresh the task detail from the server. */
  loadDetail: () => Promise<void>;
  /** Kick off the execution SSE stream for a specific taskId. */
  onAutoExecute: (executionTaskId: string) => void;
}

export function useAgentTaskPolling(input: UseAgentTaskPollingInput) {
  const {
    taskId,
    detail,
    isExecutionStreaming,
    busyAction,
    canAutoExecuteFromMessage,
    loadDetail,
    onAutoExecute,
  } = input;

  // Keep a stable reference so interval callbacks see the latest value
  // without re-registering the interval on every render.
  const inputRef = useRef(input);
  inputRef.current = input;

  // ── Rule 2: active-task polling (4 s) ──────────────────────────
  useEffect(() => {
    if (
      !detail ||
      isExecutionStreaming ||
      (detail.task.status !== "running" && detail.task.status !== "awaiting_approval")
    ) {
      return;
    }

    const timer = window.setInterval(() => {
      void inputRef.current.loadDetail();
    }, ACTIVE_POLL_INTERVAL);

    return () => window.clearInterval(timer);
  }, [detail?.task.status, isExecutionStreaming, taskId]);

  // ── Rule 3: draft-waiting polling (1.5 s) ──────────────────────
  useEffect(() => {
    if (
      isExecutionStreaming ||
      !autoExecutingTaskIds.has(detail?.task.id ?? taskId) ||
      (detail ? detail.task.status !== "draft" : false)
    ) {
      return;
    }

    const timer = window.setInterval(() => {
      void inputRef.current.loadDetail();
    }, DRAFT_POLL_INTERVAL);

    return () => window.clearInterval(timer);
  }, [detail?.task.id, detail?.task.status, isExecutionStreaming, taskId]);

  // ── Cleanup: remove from autoExecutingTaskIds when the task
  //    leaves the draft state ─────────────────────────────────────
  useEffect(() => {
    if (detail && detail.task.status !== "draft") {
      autoExecutingTaskIds.delete(detail.task.id);
      return;
    }

    // Edge case: the message already carries a non-draft taskStatus
    // before detail has loaded.
    const msgRun = inputRef.current.canAutoExecuteFromMessage;
    if (!detail && !msgRun) {
      autoExecutingTaskIds.delete(taskId);
    }
  }, [detail?.task.id, detail?.task.status, taskId]);

  // ── Rule 4: auto-execute trigger ───────────────────────────────
  useEffect(() => {
    const canAutoExecuteFromDetail = Boolean(
      detail && detail.task.autoStart && detail.task.status === "draft",
    );
    const executionTaskId =
      detail?.task.id ?? (canAutoExecuteFromMessage ? taskId : null);

    if (
      !executionTaskId ||
      (!canAutoExecuteFromDetail && !canAutoExecuteFromMessage)
    ) {
      return;
    }
    if (
      autoExecutingTaskIds.has(executionTaskId) ||
      busyAction !== null ||
      isExecutionStreaming
    ) {
      return;
    }

    autoExecutingTaskIds.add(executionTaskId);
    onAutoExecute(executionTaskId);
  }, [
    detail?.task.id,
    detail?.task.autoStart,
    detail?.task.status,
    canAutoExecuteFromMessage,
    busyAction,
    isExecutionStreaming,
    taskId,
    onAutoExecute,
  ]);
}
