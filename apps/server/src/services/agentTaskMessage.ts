import type { AgentTaskDetail } from "./agentTaskService";

/**
 * Returns the *real* user-visible summary for a task-backed agent message.
 *
 * The previewText comes from one of three real sources, in priority order:
 *   1. the latest execution run's error string (when the task failed)
 *   2. the latest final_result artifact content
 *   3. the latest run summary
 *
 * When none of those are available, this function returns an empty string —
 * never an invented placeholder. The desktop client renders task state from
 * the structured task fields (status, planSteps, approvals) when content
 * is empty, so it does not need a server-fabricated stand-in.
 */
export function buildTaskMessageSummary(detail: AgentTaskDetail): string {
  return detail.task.insight?.previewText?.trim() ?? "";
}
