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

import type { ApiAgentPlanStep, ApiAgentTaskStatus, ApiProviderErrorKind } from "../../types/chat";

const agentStatusLabels: Record<ApiAgentTaskStatus, string> = {
  draft: "待启动",
  planning: "规划中",
  awaiting_approval: "等待你的确认",
  running: "执行中",
  completed: "已完成",
  failed: "执行失败",
  cancelled: "已停止",
};

const agentPlanStepStatusLabels: Record<ApiAgentPlanStep["status"], string> = {
  pending: "待执行",
  ready: "待执行",
  running: "执行中",
  completed: "已完成",
  failed: "失败",
};

const agentErrorLabels: Record<ApiProviderErrorKind, string> = {
  quota_exhausted: "配额不足或触发限流",
  ssl_handshake_failed: "TLS/SSL 握手失败",
  gateway_failed: "上游网关异常",
  auth_failed: "鉴权失败",
  timeout: "连接或响应超时",
  protocol_incompatible: "当前渠道不兼容 Agent 运行协议",
  model_not_found: "模型不存在、不可用或已被禁用",
  request_failed: "请求失败",
  server_failed: "上游服务异常",
  network_failed: "网络连接失败",
  unknown: "发生未知错误",
};

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

/**
 * Runtime-agnostic categories used when the server is unable to produce a
 * structured errorCode but the frontend still needs to tell the user
 * something. These keys must map 1:1 to fields the server already emits.
 */
const agentRuntimeIssueLabels = {
  live_search_timeout: "实时搜索超时，任务已停止",
  live_search_failed: "实时搜索失败，任务已停止",
  live_search_empty: "实时搜索未返回可用来源，任务已停止",
  research_failed: "在线研究失败，任务已停止",
} as const;

type AgentRuntimeIssueKey = keyof typeof agentRuntimeIssueLabels;

export function getAgentStatusLabel(status: ApiAgentTaskStatus | null | undefined): string | null {
  if (!status) return null;
  return agentStatusLabels[status] ?? null;
}

export function getAgentPlanStepStatusLabel(
  status: ApiAgentPlanStep["status"] | null | undefined,
): string | null {
  if (!status) return null;
  return agentPlanStepStatusLabels[status] ?? null;
}

export function getAgentErrorLabel(
  errorCode: ApiProviderErrorKind | null | undefined,
  retryable?: boolean,
): string | null {
  if (!errorCode) return null;
  const base = agentErrorLabels[errorCode];
  if (!base) return null;
  return retryable ? `${base}，可稍后重试` : base;
}

export function getAgentActionLabel(action: AgentActionKey): string {
  return agentActionLabels[action];
}

export function getAgentRuntimeIssueLabel(key: string | null | undefined): string | null {
  if (!key) return null;
  if (Object.hasOwn(agentRuntimeIssueLabels, key)) {
    return agentRuntimeIssueLabels[key as AgentRuntimeIssueKey];
  }
  return null;
}
