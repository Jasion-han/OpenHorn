import type { ApiAgentApprovalStatus, ApiAgentApprovalType } from "../types/chat";

/**
 * Pure-function layer for the desktop agent task action buttons
 * (approval, retry, continue, cancel). Components dispatch through
 * these helpers so the actual API client can be injected for tests
 * and so the side-effect ordering is captured in one place rather
 * than scattered across button onClick handlers.
 */

export interface AgentTaskActionApi {
  respondApproval: (
    approvalId: string,
    data: {
      status: Exclude<ApiAgentApprovalStatus, "pending">;
      response?: unknown;
    },
  ) => Promise<unknown>;
  cancel: (taskId: string) => Promise<unknown>;
}

export interface RespondApprovalInput {
  api: AgentTaskActionApi;
  approvalId: string;
  approvalType: ApiAgentApprovalType;
  status: Exclude<ApiAgentApprovalStatus, "pending">;
  /**
   * Called when a plan_approval is approved. The server resets the task
   * to "draft" after a plan is accepted, so the desktop client must
   * explicitly kick off the next execution run.
   */
  onPlanApprovalAccepted?: () => Promise<void> | void;
}

export type RespondApprovalResult =
  | { ok: true }
  | { ok: false; error: string };

/**
 * Submits an approval response and, when the user accepts a plan, schedules
 * the next execution run. The two side effects are sequenced so the
 * approval is persisted *before* execution kicks off.
 */
export async function respondAgentApproval(
  input: RespondApprovalInput,
): Promise<RespondApprovalResult> {
  try {
    await input.api.respondApproval(input.approvalId, { status: input.status });
  } catch (error) {
    return { ok: false, error: extractErrorMessage(error) };
  }

  if (input.approvalType === "plan_approval" && input.status === "approved") {
    try {
      await input.onPlanApprovalAccepted?.();
    } catch (error) {
      return { ok: false, error: extractErrorMessage(error) };
    }
  }

  return { ok: true };
}

export interface CancelTaskInput {
  api: AgentTaskActionApi;
  taskId: string;
  /**
   * Called *before* the cancel request hits the server, so the desktop UI
   * can stop the local SSE stream regardless of cancel success.
   */
  onLocalAbort?: () => void;
}

export async function cancelAgentTask(
  input: CancelTaskInput,
): Promise<RespondApprovalResult> {
  input.onLocalAbort?.();
  try {
    await input.api.cancel(input.taskId);
  } catch (error) {
    return { ok: false, error: extractErrorMessage(error) };
  }
  return { ok: true };
}

function extractErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error.trim()) return error.trim();
  return "request failed";
}
