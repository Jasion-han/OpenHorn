/**
 * Agent i18n dictionary.
 *
 * This file is the ONLY place in the desktop app where user-facing Chinese
 * copy for agent states / errors / actions is allowed to live. Every other
 * source file must look up strings through these helpers instead of
 * hard-coding Chinese text.
 *
 * Rules:
 *   1. All keys are the real state enums / error codes / action ids coming
 *      from the server or the agent SDK. No invented placeholder keys.
 *   2. Every helper returns `null` when a key is missing. Callers must
 *      decide how to degrade (usually: don't render that line) — never
 *      substitute a Chinese fallback outside of this file.
 *   3. Process-stream labels (tool names like Bash / MCP / Skill, status
 *      machine literals like Approved / Rejected) stay in English elsewhere
 *      in the code base. This dictionary is for the *user-facing surface*:
 *      status badges, error messages, action buttons, and empty states.
 */

const agentActionLabels = {
  approve: "通过",
  reject: "拒绝",
  allow: "允许",
  deny: "拒绝",
  stop: "停止",
  retry: "重试",
  continueRun: "继续",
  continueAsk: "继续追问",
  rollback: "回滚此次执行",
  viewDetails: "查看详情",
} as const;

type AgentActionKey = keyof typeof agentActionLabels;

/**
 * Short panel headings and inline hints. These are user-facing copy that
 * does not map to a backend enum, so they live here rather than being
 * inlined as string literals across components.
 */
export const agentPanelLabels = {
  planApprovalHeading: "以下是 Agent 准备执行的计划",
  planApprovalHint: "通过即开始执行；拒绝后任务回到草稿。",
  toolApprovalHeading: "Agent 想要执行以下操作",
  toolApprovalHint: "通过即继续执行；拒绝则当前任务停止。",
  planSectionHeading: "执行计划",
  approvalSubmitting: "提交中...",
  approvalSubmitFailed: "提交失败",
} as const;

export function getAgentActionLabel(action: AgentActionKey): string {
  return agentActionLabels[action];
}
