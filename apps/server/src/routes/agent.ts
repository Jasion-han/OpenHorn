import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import { Hono } from "hono";
import { createAdapter } from "../agent-adapters";
import {
  buildAgentRuntimeContext,
  createAgentSession,
  deleteAgentEvent,
  deleteAgentSession,
  getAgentEvents,
  getAgentSessionById,
  getAgentSessions,
  renameAgentSession,
  runAgent,
  runAgentWithConfig,
  updateAgentSessionChannel,
  updateAgentSessionStatus,
} from "../services/agentService";
import {
  createAgentApprovalRequest,
  createAgentArtifact,
  createAgentRun,
  createAgentTask,
  createAgentTaskEvent,
  getAgentTaskById,
  getAgentTaskDetail,
  getLatestApprovalForTask,
  getLatestRunForTask,
  listAgentArtifacts,
  listAgentTaskEvents,
  listAgentTasks,
  respondToAgentApproval,
  setAgentPlanSteps,
  updateAgentPlanStepStatuses,
  updateAgentTask,
  updateAgentRunStatus,
  updateAgentTaskStatus,
} from "../services/agentTaskService";
import { buildAgentPlan } from "../services/agentPlanBuilder";
import { generateAutoTitle } from "../services/autoTitleService";
import { mergeAgentTextOutput } from "../services/agentSdk";
import {
  getAgentCapabilityModeFromSuccessResult,
  resolveAgentRuntime,
} from "../services/channelAgentCheckService";
import { getResolvedChannelForConversation } from "../services/channelService";
import { createAgentStreamTimeoutGuard } from "../services/agentStreamTimeouts";
import { syncTaskBackedMessages } from "../services/messageService";
import { requireUser, type UserEnv } from "../utils/requestUser";
import { classifyBashCommandRisk } from "../utils/shellRisk";
import { createSseStream } from "../utils/sse";
import { isRecord } from "../utils/typeGuards";

type AgentRouteDeps = {
  requireUserMiddleware: typeof requireUser;
  createAdapter: typeof createAdapter;
  buildAgentRuntimeContext: typeof buildAgentRuntimeContext;
  createAgentSession: typeof createAgentSession;
  deleteAgentEvent: typeof deleteAgentEvent;
  deleteAgentSession: typeof deleteAgentSession;
  getAgentEvents: typeof getAgentEvents;
  getAgentSessionById: typeof getAgentSessionById;
  getAgentSessions: typeof getAgentSessions;
  renameAgentSession: typeof renameAgentSession;
  runAgent: typeof runAgent;
  runAgentWithConfig: typeof runAgentWithConfig;
  updateAgentSessionChannel: typeof updateAgentSessionChannel;
  updateAgentSessionStatus: typeof updateAgentSessionStatus;
  createAgentApprovalRequest: typeof createAgentApprovalRequest;
  createAgentArtifact: typeof createAgentArtifact;
  createAgentRun: typeof createAgentRun;
  createAgentTask: typeof createAgentTask;
  createAgentTaskEvent: typeof createAgentTaskEvent;
  getAgentTaskById: typeof getAgentTaskById;
  getAgentTaskDetail: typeof getAgentTaskDetail;
  getLatestApprovalForTask: typeof getLatestApprovalForTask;
  getLatestRunForTask: typeof getLatestRunForTask;
  listAgentArtifacts: typeof listAgentArtifacts;
  listAgentTaskEvents: typeof listAgentTaskEvents;
  listAgentTasks: typeof listAgentTasks;
  respondToAgentApproval: typeof respondToAgentApproval;
  setAgentPlanSteps: typeof setAgentPlanSteps;
  updateAgentPlanStepStatuses: typeof updateAgentPlanStepStatuses;
  updateAgentTask: typeof updateAgentTask;
  updateAgentRunStatus: typeof updateAgentRunStatus;
  updateAgentTaskStatus: typeof updateAgentTaskStatus;
  generateAutoTitle: typeof generateAutoTitle;
  resolveAgentRuntime: typeof resolveAgentRuntime;
  getAgentCapabilityModeFromSuccessResult: typeof getAgentCapabilityModeFromSuccessResult;
  getResolvedChannelForConversation: typeof getResolvedChannelForConversation;
  createAgentStreamTimeoutGuard: typeof createAgentStreamTimeoutGuard;
};

const defaultAgentRouteDeps: AgentRouteDeps = {
  requireUserMiddleware: requireUser,
  createAdapter,
  buildAgentRuntimeContext,
  createAgentSession,
  deleteAgentEvent,
  deleteAgentSession,
  getAgentEvents,
  getAgentSessionById,
  getAgentSessions,
  renameAgentSession,
  runAgent,
  runAgentWithConfig,
  updateAgentSessionChannel,
  updateAgentSessionStatus,
  createAgentApprovalRequest,
  createAgentArtifact,
  createAgentRun,
  createAgentTask,
  createAgentTaskEvent,
  getAgentTaskById,
  getAgentTaskDetail,
  getLatestApprovalForTask,
  getLatestRunForTask,
  listAgentArtifacts,
  listAgentTaskEvents,
  listAgentTasks,
  respondToAgentApproval,
  setAgentPlanSteps,
  updateAgentPlanStepStatuses,
  updateAgentTask,
  updateAgentRunStatus,
  updateAgentTaskStatus,
  generateAutoTitle,
  resolveAgentRuntime,
  getAgentCapabilityModeFromSuccessResult,
  getResolvedChannelForConversation,
  createAgentStreamTimeoutGuard,
};

export function createAgentRouter(overrides: Partial<AgentRouteDeps> = {}) {
  const {
    requireUserMiddleware,
    createAdapter,
    buildAgentRuntimeContext,
    createAgentSession,
    deleteAgentEvent,
    deleteAgentSession,
    getAgentEvents,
    getAgentSessionById,
    getAgentSessions,
    renameAgentSession,
    runAgent,
    runAgentWithConfig,
    updateAgentSessionChannel,
    updateAgentSessionStatus,
    createAgentApprovalRequest,
    createAgentArtifact,
    createAgentRun,
    createAgentTask,
    createAgentTaskEvent,
    getAgentTaskById,
    getAgentTaskDetail,
    getLatestApprovalForTask,
    getLatestRunForTask,
    listAgentArtifacts,
    listAgentTaskEvents,
    listAgentTasks,
    respondToAgentApproval,
    setAgentPlanSteps,
    updateAgentPlanStepStatuses,
    updateAgentTask,
    updateAgentRunStatus,
    updateAgentTaskStatus,
    generateAutoTitle,
    resolveAgentRuntime,
    getAgentCapabilityModeFromSuccessResult,
    getResolvedChannelForConversation,
    createAgentStreamTimeoutGuard,
  } = { ...defaultAgentRouteDeps, ...overrides };

  const agent = new Hono<UserEnv>();

  agent.use("*", requireUserMiddleware);

  function buildPlanFromTask(task: {
    goal: string;
    complexity?: "light" | "standard" | "deep" | null;
    attachments?: Array<{
      id?: string;
      fileName: string;
      fileType?: string;
      fileSize?: number;
    }> | null;
  }) {
    return buildAgentPlan({
      goal: task.goal,
      complexity: task.complexity ?? "standard",
      attachments: task.attachments ?? [],
    });
  }

function parseTaskComplexity(value: unknown) {
  return value === "light" || value === "standard" || value === "deep" ? value : undefined;
}

function parseTaskUxMode(value: unknown) {
  return value === "direct" || value === "compact" || value === "full" ? value : undefined;
}

function buildExecutionPrompt(
  goal: string,
  planSteps: Array<{ title: string; description?: string | null }>,
) {
  const normalizedGoal = goal.trim();
  const renderedPlan = planSteps
    .map((step, index) =>
      [`${index + 1}. ${step.title}`, step.description?.trim()].filter(Boolean).join("\n"),
    )
    .join("\n\n");

  const requiresWorkspaceInspection =
    /(^|[\s(])(?:readme|repo|repository|codebase|workspace|package\.json|tsconfig|src\/|apps\/|README\.md)(?=$|[\s).,:/])/i.test(
      normalizedGoal,
    ) ||
    /读取|查看|检查|分析|总结|梳理|修改|排查|修复|仓库|代码库|工作区|文件|源码|目录|README/i.test(
      normalizedGoal,
    );

  const toolDirective = requiresWorkspaceInspection
    ? [
        "Execution requirements:",
        "- This is a workspace-grounded task.",
        "- Before answering, inspect the relevant local files or paths with real tools.",
        "- Do not answer only from prior context or system context when the task asks about README, code, files, or the repository.",
        "- If a referenced local file cannot be found, say that explicitly after checking.",
      ].join("\n")
    : null;

  return [`Approved task goal:`, normalizedGoal, `Approved execution plan:`, renderedPlan, toolDirective]
    .filter(Boolean)
    .join("\n\n");
}

function summarizeExecution(params: {
  finalText: string;
  toolStarts: number;
  toolResults: number;
  hadError: boolean;
}) {
  const parts = [
    params.hadError ? "Execution ended with an error." : "Execution completed.",
    `Tool starts: ${params.toolStarts}.`,
    `Tool results: ${params.toolResults}.`,
    `Final text length: ${params.finalText.trim().length}.`,
  ];
  return parts.join(" ");
}

function buildLiveSearchSummary(params: {
  route: "web_search" | "research";
  prompt: string;
  citations?: Array<{ title: string; url: string }>;
}) {
  const sourceTitles = (params.citations || [])
    .map((citation) => citation.title?.trim())
    .filter((title): title is string => Boolean(title))
    .slice(0, 2);
  if (sourceTitles.length === 0) {
    return params.route === "research" ? "已完成在线研究检索。" : "已完成网络搜索。";
  }
  const prefix = params.route === "research" ? "已参考" : "已检索";
  return `${prefix}${sourceTitles.join("、")} 等来源。`;
}

function buildLiveSearchFailureMessage(params: {
  route: "web_search" | "research";
  userLabel?: string;
}) {
  const label = params.userLabel?.trim();
  if (label) return label;
  return params.route === "research" ? "在线研究失败，任务已停止" : "实时搜索失败，任务已停止";
}

/**
 * Returns the structured runtime issue key the desktop client uses to look
 * up a localized message for an upstream live-search failure. The key has a
 * 1:1 mapping to entries in `apps/desktop/src/lib/i18n/agent.ts`.
 */
function getLiveSearchRuntimeIssue(route: "web_search" | "research"): string {
  return route === "research" ? "research_failed" : "live_search_failed";
}

function normalizeCitationSnippetText(value: string) {
  return value
    .replace(/\r\n/g, "\n")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, "$1")
    .replace(/`{1,3}/g, "")
    .replace(/[|•·]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function truncateAtSentenceBoundary(value: string, limit: number) {
  if (value.length <= limit) return value;
  const truncated = value.slice(0, limit);
  const sentenceBoundary = Math.max(
    truncated.lastIndexOf("。"),
    truncated.lastIndexOf("！"),
    truncated.lastIndexOf("？"),
    truncated.lastIndexOf(". "),
    truncated.lastIndexOf("! "),
    truncated.lastIndexOf("? "),
  );
  if (sentenceBoundary >= Math.floor(limit * 0.45)) {
    return truncated.slice(0, sentenceBoundary + 1).trim();
  }

  const wordBoundary = truncated.lastIndexOf(" ");
  if (wordBoundary >= Math.floor(limit * 0.6)) {
    return `${truncated.slice(0, wordBoundary).trim()}…`;
  }
  return `${truncated.trim()}…`;
}

function buildSummaryFallback(citation: { title: string; url: string }) {
  const title = citation.title.toLowerCase();
  const url = citation.url.toLowerCase();
  if (/responses overview/.test(title) || /\/responses\/overview/.test(url)) {
    return "这是 OpenAI Responses API 的总览页，介绍响应生成、工具调用和多轮状态管理能力。";
  }
  return "这是与该问题最相关的官方文档页面。";
}

function buildCleanCitationSummary(citation: {
  title: string;
  url: string;
  snippet?: string;
}) {
  const rawSnippet = citation.snippet?.trim() || "";
  if (!rawSnippet) {
    return buildSummaryFallback(citation);
  }

  const headingSegments = rawSnippet
    .split(/\s*#{1,6}\s+/g)
    .map((segment) => normalizeCitationSnippetText(segment))
    .filter(Boolean);

  const scoreSegment = (segment: string) => {
    let score = 0;
    if (segment.length >= 30) score += 2;
    if (/[.!?。！？]/.test(segment)) score += 4;
    if (
      /interface|supports|allows|provides|overview|guide|model|api|介绍|概览|支持|文档|能力/i.test(
        segment,
      )
    ) {
      score += 4;
    }
    if (/^(?:[A-Z][A-Za-z]+(?:\s+|$)){5,}/.test(segment)) {
      score -= 3;
    }
    return score;
  };

  let bestSegment =
    headingSegments
      .map((segment) => ({ segment, score: scoreSegment(segment) }))
      .sort((left, right) => right.score - left.score)[0]?.segment || "";

  if (!bestSegment) {
    bestSegment = normalizeCitationSnippetText(rawSnippet);
  }

  const titlePrefix = citation.title.split("|")[0]?.trim();
  if (titlePrefix && bestSegment.toLowerCase().startsWith(titlePrefix.toLowerCase())) {
    bestSegment = bestSegment.slice(titlePrefix.length).trim();
  }
  bestSegment = bestSegment.replace(
    /^(?:[A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){0,3})\s+(?=[A-Z][A-Za-z]+[’']s\s)/,
    "",
  );

  const sentences =
    bestSegment.match(/[^.!?。！？]+[.!?。！？]?/g)?.map((item) => item.trim()).filter(Boolean) || [];
  const summaryParts: string[] = [];
  for (const sentence of sentences) {
    if (!sentence) continue;
    if (summaryParts.length === 0 && sentence.length < 12 && sentences.length > 1) {
      continue;
    }
    const next = [...summaryParts, sentence].join(" ").trim();
    if (next.length > 180) break;
    summaryParts.push(sentence);
    if (next.length >= 70 || summaryParts.length >= 2) break;
  }

  const summary = (summaryParts.join(" ").trim() || bestSegment).replace(/\s+/g, " ");
  if (!summary || /^#+/.test(summary)) {
    return buildSummaryFallback(citation);
  }
  return truncateAtSentenceBoundary(summary, 180);
}

function pickBestCitationForGoal(
  goal: string,
  citations: Array<{ title: string; url: string; snippet?: string }>,
) {
  const normalizedGoal = goal.toLowerCase();
  const wantsHomepage = /官方首页|官网|首页|homepage|home page|official home/i.test(goal);
  const wantsDocs = /api|docs|文档|reference|responses|帮助文档|help/i.test(goal);
  return [...citations]
    .map((citation, index) => {
      const title = citation.title.toLowerCase();
      const url = citation.url.toLowerCase();
      let score = 0;

      if (wantsHomepage) {
        if (/^https?:\/\/(www\.)?openai\.com\/?$/.test(url)) score += 80;
        else if (/openai\.com\/(?!blog|index|api|docs|research|careers|newsroom)/.test(url)) score += 24;
        else if (/openai\.com/.test(url)) score += 8;
      } else {
        if (/developers\.openai\.com\/api\/reference/.test(url)) score += 30;
        else if (/platform\.openai\.com\/docs\/api-reference/.test(url)) score += 28;
        else if (/developers\.openai\.com\/api\/docs/.test(url)) score += 20;
        else if (/developers\.openai\.com|platform\.openai\.com/.test(url)) score += 14;
        else if (/openai\.com/.test(url)) score += 4;
      }

      if (/community\.openai\.com|help\.openai\.com/.test(url)) score -= 30;
      if (/\/index\//.test(url)) score -= 8;

      if (wantsHomepage) {
        if (/openai/.test(title)) score += 12;
        if (/home|homepage|首页|openai/.test(title) && /^https?:\/\/(www\.)?openai\.com\/?$/.test(url)) {
          score += 20;
        }
        if (/docs|reference|api|help|帮助文档/.test(title + url)) score -= 18;
      } else if (wantsDocs) {
        if (/responses overview/.test(title)) score += 16;
        if (/responses api/.test(title)) score += 12;
        if (/responses/.test(title) || /responses/.test(url)) score += 8;
        if (/api reference/.test(title) || /reference/.test(url)) score += 8;
        if (/docs/.test(url)) score += 4;
      }

      if (/openai/.test(normalizedGoal) && /openai/.test(title + url)) score += 2;
      if (!wantsHomepage && /标题|title/i.test(goal) && /overview|reference|标题|title/i.test(title)) {
        score += 6;
      }
      score -= index * 0.01;

      return { citation, score };
    })
    .sort((left, right) => right.score - left.score)[0]?.citation;
}

function isTitleOnlyGoal(goal: string) {
  return /(?:只|仅)(?:返回|给出|输出)?标题|只要标题|title only|only return (?:the )?title/i.test(goal);
}

function buildCitationTitleAnswer(params: {
  goal: string;
  citation: { title: string; url: string; snippet?: string };
}) {
  if (isTitleOnlyGoal(params.goal)) {
    return params.citation.title.trim();
  }

  const summary = buildCleanCitationSummary(params.citation);

  return [
    `最相关的官方来源标题是：${params.citation.title} [1]`,
    `一句总结：${summary}`,
    `[1] ${params.citation.url}`,
  ].join("\n\n");
}

function buildExecutionModeContext(params: {
  mode: "execute" | "retry" | "continue";
  previousRun?: { summary: string | null; error: string | null } | null;
  previousFinalResult?: string | null;
  resumeStepTitle?: string | null;
  completedStepTitles?: string[];
}) {
  if (params.mode === "execute") {
    return null;
  }

  const parts: string[] = [];
  if (params.mode === "retry") {
    parts.push("Execution mode: retry the task from scratch.");
    parts.push(
      "Ignore any incomplete prior progress and execute the approved plan again from the beginning.",
    );
  } else {
    parts.push("Execution mode: continue from the previous attempt when useful.");
    if ((params.completedStepTitles?.length ?? 0) > 0) {
      parts.push(
        `Completed plan steps from the previous attempt:\n${params.completedStepTitles!.map((title) => `- ${title}`).join("\n")}`,
      );
    }
    if (params.resumeStepTitle) {
      parts.push(
        `Resume focus: continue from the next unfinished plan step.\n${params.resumeStepTitle}`,
      );
    } else {
      parts.push(
        "All approved plan steps were previously completed. Continue by refining or extending the latest result when useful.",
      );
    }
  }

  const previousSummary =
    params.previousRun?.summary?.trim() || params.previousRun?.error?.trim() || "";
  if (previousSummary) {
    parts.push(`Previous attempt summary:\n${previousSummary}`);
  }

  const previousFinalResult = params.previousFinalResult?.trim() || "";
  if (previousFinalResult) {
    parts.push(`Previous final result draft:\n${previousFinalResult.slice(0, 2500)}`);
  }

  return parts.join("\n\n");
}

type ExecutionPlanStepStatus = "pending" | "ready" | "running" | "completed" | "failed";

type ExecutionPlanStepShape = {
  id: string;
  status: ExecutionPlanStepStatus;
};

function getContinueResumeStepIndex(planSteps: Array<{ status: ExecutionPlanStepStatus }>) {
  const firstNonCompletedIndex = planSteps.findIndex(
    (step, index) => index > 0 && step.status !== "completed",
  );
  if (firstNonCompletedIndex >= 0) {
    return firstNonCompletedIndex;
  }
  if (planSteps.length === 0) {
    return -1;
  }
  return planSteps.length > 1 ? planSteps.length - 1 : 0;
}

function buildExecutionStepStartStatuses(
  mode: "execute" | "retry" | "continue",
  planSteps: Array<{ id: string; status: ExecutionPlanStepStatus }>,
): ExecutionPlanStepShape[] {
  if (planSteps.length === 0) {
    return [];
  }

  const activeIndex =
    mode === "continue" ? getContinueResumeStepIndex(planSteps) : planSteps.length > 1 ? 1 : 0;

  return planSteps.map((step, index) => ({
    id: step.id,
    status: index < activeIndex ? "completed" : index === activeIndex ? "running" : "pending",
  }));
}

function buildExecutionFailureStatuses(
  planSteps: Array<{ id: string; status: ExecutionPlanStepStatus }>,
): ExecutionPlanStepShape[] {
  const activeIndex = planSteps.findIndex((step) => step.status === "running");
  if (activeIndex < 0) {
    return [];
  }
  return planSteps.map((step, index) => ({
    id: step.id,
    status: index < activeIndex ? "completed" : index === activeIndex ? "failed" : "pending",
  }));
}

function buildExecutionSuccessStatuses(planSteps: Array<{ id: string }>): ExecutionPlanStepShape[] {
  return planSteps.map((step) => ({
    id: step.id,
    status: "completed" as const,
  }));
}

async function syncExecutionPlanSteps(params: {
  userId: string;
  taskId: string;
  executionRunId: string;
  planSteps: Array<{
    id: string;
    orderIndex: number;
    title: string;
    status: "pending" | "ready" | "running" | "completed" | "failed";
  }>;
  nextStatuses: Array<{
    id: string;
    status: "pending" | "ready" | "running" | "completed" | "failed";
  }>;
  send: (event: Record<string, unknown>) => void;
}) {
  const updates = params.nextStatuses.filter((nextStep) => {
    const current = params.planSteps.find((step) => step.id === nextStep.id);
    return current && current.status !== nextStep.status;
  });
  if (updates.length === 0) {
    return;
  }

  const updatedSteps = await updateAgentPlanStepStatuses(params.userId, { steps: updates });
  for (const updatedStep of updatedSteps) {
    const local = params.planSteps.find((step) => step.id === updatedStep.id);
    if (local) {
      local.status = updatedStep.status;
    }
    await createAgentTaskEvent(params.userId, params.taskId, params.executionRunId, {
      type: "plan_step",
      content: updatedStep.title,
      metadata: {
        stepId: updatedStep.id,
        orderIndex: updatedStep.orderIndex,
        status: updatedStep.status,
        source: "execution",
      },
    });
    params.send({
      type: "plan_step",
      taskId: params.taskId,
      runId: params.executionRunId,
      stepId: updatedStep.id,
      orderIndex: updatedStep.orderIndex,
      title: updatedStep.title,
      status: updatedStep.status,
    });
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForApprovalResolution(params: {
  userId: string;
  taskId: string;
  approvalId: string;
  signal?: AbortSignal;
}) {
  while (true) {
    const detail = await getAgentTaskDetail(params.userId, params.taskId);
    const approval = detail.approvals.find((item) => item.id === params.approvalId) ?? null;
    if (approval && approval.status !== "pending") {
      return approval;
    }
    await sleep(600);
  }
}

async function resolveTaskExecutionContext(
  userId: string,
  taskId: string,
  mode: "execute" | "retry" | "continue",
) {
  const task = await getAgentTaskById(userId, taskId);
  if (!task) {
    return { error: "Task not found", status: 404 as const };
  }

  const latestApproval = await getLatestApprovalForTask(userId, taskId, "plan_approval");
  const latestPlanningRun = await getLatestRunForTask(userId, taskId, "planning");
  const approvedPlanRunId = task.requiresPlanApproval
    ? latestApproval?.status === "approved"
      ? latestApproval.runId
      : null
    : latestPlanningRun?.id ?? null;

  if (!approvedPlanRunId) {
    return {
      error: task.requiresPlanApproval
        ? "Task plan must be approved before execution."
        : "Task plan is not ready for execution.",
      status: 400 as const,
    };
  }

  const explicitTaskChannelId = task.channelId?.trim() || null;
  const explicitTaskModelId = task.modelId?.trim() || null;
  const directResolvedChannel =
    explicitTaskChannelId && explicitTaskModelId
      ? await getResolvedChannelForConversation(userId, {
          channelId: explicitTaskChannelId,
          modelId: explicitTaskModelId,
        })
      : null;

  const runtimeResolution =
    directResolvedChannel && directResolvedChannel.channel.protocol === "openai"
      ? {
          success: true as const,
          resolvedChannel: directResolvedChannel,
          compatibility: { success: true as const, mode: "generic_tool_calling" as const },
          fallbackUsed: false,
          attempts: [],
        }
      : await resolveAgentRuntime({
          userId,
          requestedChannelId: task.channelId,
          requestedModelId: task.modelId,
          bypassCache: true,
        });

  if (runtimeResolution.success === false) {
    return {
      error: runtimeResolution.error,
      status: 400 as const,
      persistAsFailedRun: true as const,
      failureStage: "runtime_resolution" as const,
      errorCode: runtimeResolution.errorCode,
      retryable: runtimeResolution.retryable,
      rawError: runtimeResolution.rawError,
    };
  }
  const resolvedChannel = runtimeResolution.resolvedChannel;
  const compatibility = runtimeResolution.compatibility;

  const detail = await getAgentTaskDetail(userId, taskId);
  const approvedPlanSteps = detail.planSteps
    .filter((step) => step.runId === approvedPlanRunId)
    .sort((left, right) => left.orderIndex - right.orderIndex);

  if (approvedPlanSteps.length === 0) {
    return { error: "Task plan is not ready for execution.", status: 400 as const };
  }

  if (mode === "retry" && !["failed", "cancelled", "completed"].includes(task.status)) {
    return {
      error: "Only failed, cancelled, or completed tasks can be retried.",
      status: 400 as const,
    };
  }

  if (mode === "continue" && !["failed", "completed"].includes(task.status)) {
    return { error: "Only failed or completed tasks can be continued.", status: 400 as const };
  }

  const previousExecutionRun =
    mode === "execute" ? null : await getLatestRunForTask(userId, taskId, "execution");

  const previousFinalResult = previousExecutionRun
    ? (detail.artifacts.find(
        (artifact) =>
          artifact.runId === previousExecutionRun.id && artifact.type === "final_result",
      )?.content ?? null)
    : null;
  const continueResumeIndex = getContinueResumeStepIndex(approvedPlanSteps);
  const hasUnfinishedContinueStep =
    mode === "continue" &&
    approvedPlanSteps.some((step, index) => index > 0 && step.status !== "completed");

  const taskModeContext = buildExecutionModeContext({
    mode,
    previousRun: previousExecutionRun,
    previousFinalResult,
    resumeStepTitle:
      mode === "continue" && hasUnfinishedContinueStep
        ? (approvedPlanSteps[continueResumeIndex]?.title ?? null)
        : null,
    completedStepTitles:
      mode === "continue"
        ? approvedPlanSteps.filter((step) => step.status === "completed").map((step) => step.title)
        : [],
  });
  const executionPrompt = [taskModeContext, buildExecutionPrompt(task.goal, approvedPlanSteps)]
    .filter((value): value is string => Boolean(value))
    .join("\n\n");

  return {
    task,
    approvedPlanSteps,
    executionPrompt,
    resolvedChannel,
    compatibility,
    fallbackUsed: runtimeResolution.fallbackUsed,
  };
}

function shouldPersistExecutionStartFailure(
  resolved: Awaited<ReturnType<typeof resolveTaskExecutionContext>>,
): resolved is Extract<
  Awaited<ReturnType<typeof resolveTaskExecutionContext>>,
  { error: string; status: 400; persistAsFailedRun: true }
> {
  return "error" in resolved && resolved.status === 400 && resolved.persistAsFailedRun === true;
}

async function createTaskExecutionResponse(
  userId: string,
  taskId: string,
  mode: "execute" | "retry" | "continue",
) {
  const resolved = await resolveTaskExecutionContext(userId, taskId, mode);
  if ("error" in resolved) {
    if (shouldPersistExecutionStartFailure(resolved)) {
      const failedAt = new Date();
      const run = await createAgentRun(userId, taskId, {
        phase: "execution",
        status: "failed",
        error: resolved.error,
        startedAt: failedAt,
        completedAt: failedAt,
      }).catch(() => null);

      await updateAgentTaskStatus(userId, taskId, "failed").catch(() => undefined);

      if (run) {
        await createAgentTaskEvent(userId, taskId, run.id, {
          type: "error",
          content: resolved.error,
        }).catch(() => undefined);
        await createAgentTaskEvent(userId, taskId, run.id, {
          type: "task_status",
          content: "Task failed before execution could start.",
          metadata: {
            status: "failed",
            mode,
            stage: resolved.failureStage,
            errorCode: resolved.errorCode,
            retryable: resolved.retryable,
            rawError: resolved.rawError,
          },
        }).catch(() => undefined);
      }

      await syncTaskBackedMessages(userId, taskId).catch(() => undefined);
    }

    return new Response(resolved.error, { status: resolved.status });
  }

  const { task, approvedPlanSteps, executionPrompt, resolvedChannel, compatibility } = resolved;
  const attachmentIds = task.attachments
    .map((attachment) => attachment.id)
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0);

  const stream = createSseStream(async (send, ctx) => {
    const run = await createAgentRun(userId, taskId, {
      phase: "execution",
      status: "running",
      startedAt: new Date(),
    });

    let finalText = "";
    let toolStarts = 0;
    let toolResults = 0;
    let hadError = false;
    let errorText: string | null = null;

    await updateAgentTaskStatus(userId, taskId, "running");
    await createAgentTaskEvent(userId, taskId, run.id, {
      type: "task_status",
      content: "Task execution started.",
      metadata: { status: "running", mode },
    });
    send({ type: "task_status", taskId, runId: run.id, status: "running" });
    await syncExecutionPlanSteps({
      userId,
      taskId,
      executionRunId: run.id,
      planSteps: approvedPlanSteps,
      nextStatuses: buildExecutionStepStartStatuses(mode, approvedPlanSteps),
      send,
    });

    const canUseTool: CanUseTool = async (toolName, toolInput, options) => {
      if (options.blockedPath) {
        return {
          behavior: "deny",
          message: `Blocked path: ${options.blockedPath}`,
          interrupt: true,
        };
      }

      if (toolName !== "Bash") {
        return { behavior: "allow" };
      }

      const command =
        typeof toolInput.command === "string"
          ? toolInput.command
          : typeof toolInput.cmd === "string"
            ? toolInput.cmd
            : "";
      const risk = classifyBashCommandRisk(command);
      if (risk.level === "allow") {
        return { behavior: "allow" };
      }

      const approval = await createAgentApprovalRequest(userId, taskId, run.id, {
        type: "tool_approval",
        title: "Approve Bash command",
        description:
          risk.reason ??
          options.decisionReason ??
          "This command requires explicit approval before it can run.",
        payload: {
          toolUseId: options.toolUseID,
          toolName,
          toolInput,
          blockedPath: options.blockedPath ?? null,
          decisionReason: risk.reason ?? options.decisionReason ?? null,
        },
      });

      await updateAgentRunStatus(userId, run.id, "awaiting_approval");
      await updateAgentTaskStatus(userId, taskId, "awaiting_approval");
      await createAgentTaskEvent(userId, taskId, run.id, {
        type: "approval_requested",
        content: approval.title,
        metadata: {
          approvalId: approval.id,
          approvalType: approval.type,
          toolName,
          toolUseId: options.toolUseID,
        },
      });
      await createAgentTaskEvent(userId, taskId, run.id, {
        type: "task_status",
        content: "Task is awaiting tool approval.",
        metadata: {
          status: "awaiting_approval",
          approvalId: approval.id,
          approvalType: approval.type,
        },
      });
      send({ type: "task_status", taskId, runId: run.id, status: "awaiting_approval" });

      const resolvedApproval = await waitForApprovalResolution({
        userId,
        taskId,
        approvalId: approval.id,
      });

      if (resolvedApproval.status === "approved") {
        await updateAgentRunStatus(userId, run.id, "running");
        await updateAgentTaskStatus(userId, taskId, "running");
        await createAgentTaskEvent(userId, taskId, run.id, {
          type: "task_status",
          content: "Task resumed after tool approval.",
          metadata: { status: "running", approvalId: approval.id, approvalType: approval.type },
        });
        send({ type: "task_status", taskId, runId: run.id, status: "running" });
        return { behavior: "allow" };
      }

      return {
        behavior: "deny",
        message: "User denied tool approval",
        interrupt: true,
      };
    };

    const runtimeContext = await buildAgentRuntimeContext({
      userId,
      prompt: task.goal,
      channelId: resolvedChannel.channel.id,
      modelId: resolvedChannel.modelId,
      conversationId: task.conversationId,
    });

    try {
      // Skip live search when the task goal clearly targets the local
      // workspace (mentions "仓库", "repo", "README", "package.json",
      // etc.). The live route classifier sometimes mis-classifies
      // workspace questions as needing web_search because the topic
      // keywords (e.g. "前端框架") look research-y. For these tasks
      // the agent should inspect the workspace, not the internet.
      const goalLooksLikeWorkspaceTask =
        /(仓库|代码库|工作区|项目|源码|目录|repo|repository|codebase|workspace|readme|package\.json|tsconfig|src\/|apps\/)/i.test(
          task.goal,
        );
      const liveSearchRoute =
        runtimeContext.liveContext &&
        !goalLooksLikeWorkspaceTask &&
        (runtimeContext.liveContext.route === "web_search" ||
          runtimeContext.liveContext.route === "research")
          ? runtimeContext.liveContext.route
          : null;
      const liveSearchFailedBeforeExecution =
        Boolean(liveSearchRoute) && runtimeContext.liveContext?.status === "offline";

      if (liveSearchRoute) {
        toolStarts += 1;
        await createAgentTaskEvent(userId, taskId, run.id, {
          type: "execution_event",
          content: null,
          toolName: liveSearchRoute,
          toolInput: { query: task.goal },
          metadata: { eventType: "tool_start", source: "live_context" },
        });
        send({
          type: "execution_event",
          taskId,
          runId: run.id,
          eventType: "tool_start",
          toolName: liveSearchRoute,
          toolInput: { query: task.goal },
          content: null,
        });

        if (runtimeContext.liveContext?.status === "live") {
          toolResults += 1;
          const summary = buildLiveSearchSummary({
            route: liveSearchRoute,
            prompt: task.goal,
            citations: runtimeContext.liveContext.citations,
          });
          await createAgentTaskEvent(userId, taskId, run.id, {
            type: "execution_event",
            content: summary,
            toolName: liveSearchRoute,
            metadata: { eventType: "tool_result", source: "live_context" },
          });
          send({
            type: "execution_event",
            taskId,
            runId: run.id,
            eventType: "tool_result",
            toolName: liveSearchRoute,
            content: summary,
          });
        } else {
          hadError = true;
          errorText = buildLiveSearchFailureMessage({
            route: liveSearchRoute,
            userLabel: runtimeContext.liveContext?.userLabel,
          });
          const runtimeIssue = getLiveSearchRuntimeIssue(liveSearchRoute);
          await createAgentTaskEvent(userId, taskId, run.id, {
            type: "error",
            content: errorText,
            metadata: {
              source: "live_context",
              toolName: liveSearchRoute,
              runtimeIssue,
            },
          });
          send({
            type: "error",
            taskId,
            runId: run.id,
            content: errorText,
            metadata: {
              source: "live_context",
              toolName: liveSearchRoute,
              runtimeIssue,
            },
          });
        }
      }

      const shouldUseDirectLiveAnswer =
        runtimeContext.liveContext?.status === "live" &&
        (runtimeContext.liveContext.route === "web_search" ||
          runtimeContext.liveContext.route === "research") &&
        task.complexity !== "deep" &&
        attachmentIds.length === 0;

      if (liveSearchFailedBeforeExecution) {
        finalText = "";
      } else if (shouldUseDirectLiveAnswer) {
        const directCitations = runtimeContext.liveContext?.citations || [];
        const shouldUseCitationTitleAnswer =
          /标题|title/i.test(task.goal) && directCitations.length > 0;
        if (shouldUseCitationTitleAnswer) {
          const bestCitation = pickBestCitationForGoal(task.goal, directCitations);
          if (bestCitation) {
            finalText = buildCitationTitleAnswer({
              goal: task.goal,
              citation: bestCitation,
            });
          }
        }

        if (!finalText.trim()) {
          const adapter = createAdapter(
            resolvedChannel.channel.protocol,
            resolvedChannel.apiKey,
            resolvedChannel.channel.baseUrl || undefined,
          );
          const directLiveGuardrail = [
            "You already have the live search/research results in system context.",
            "Answer directly from that context.",
            "If the provided sources contain a relevant official page, use it instead of saying the results are insufficient.",
            "Choose the most relevant official source match when multiple sources are present.",
            "Do not mention internal tool limits, unavailable browsing tools, Cursor docs, or environment restrictions.",
            "If sources are provided, cite them inline with [n] only and do not append a final references section.",
          ].join(" ");
          const response = await adapter.chat({
            model: resolvedChannel.modelId,
            messages: [
              {
                role: "system",
                content: [directLiveGuardrail, runtimeContext.liveSystemContext]
                  .filter((value): value is string => Boolean(value?.trim()))
                  .join("\n\n"),
              },
              {
                role: "user",
                content: task.goal,
              },
            ],
            temperature: 0,
            maxTokens: 1400,
            signal: ctx.signal,
          });
          finalText = response.content.trim();
        }
      } else {
        for await (const event of runAgentWithConfig({
          userId,
          prompt: executionPrompt,
          attachmentIds,
          channelId: runtimeContext.channelId,
          modelId: runtimeContext.modelId,
          capabilityMode: getAgentCapabilityModeFromSuccessResult(
            compatibility,
            resolvedChannel.channel.protocol,
          ),
          globalSystemPrompt: runtimeContext.globalSystemPrompt,
          liveSystemContext: runtimeContext.liveSystemContext,
          permissionMode: "default",
          canUseTool,
          abortController: ctx.abortController,
        })) {
          if (event.type === "meta" || event.type === "done" || event.type === "user") {
            continue;
          }

          if (event.type === "thought") {
            const thoughtChunk = event.content ?? "";
            if (thoughtChunk.trim()) {
              await createAgentTaskEvent(userId, taskId, run.id, {
                type: "execution_event",
                content: thoughtChunk,
                metadata: { eventType: "thought" },
              });
              send({
                type: "execution_event",
                taskId,
                runId: run.id,
                eventType: "thought",
                content: thoughtChunk,
              });
            }
            continue;
          }

          if (event.type === "text_delta") {
            const textChunk = event.content ?? "";
            if (textChunk) {
              send({
                type: "execution_event",
                taskId,
                runId: run.id,
                eventType: "text_delta",
                content: textChunk,
              });
            }
            continue;
          }

          if (event.type === "text_reset") {
            send({
              type: "execution_event",
              taskId,
              runId: run.id,
              eventType: "text_reset",
              content: null,
            });
            continue;
          }

          if (event.type === "text") {
            const textChunk = event.content ?? "";
            finalText = mergeAgentTextOutput(finalText, textChunk);
            if (textChunk.trim()) {
              await createAgentTaskEvent(userId, taskId, run.id, {
                type: "execution_event",
                content: textChunk,
                metadata: { eventType: "text" },
              });
              if (!event.streamed) {
                send({
                  type: "execution_event",
                  taskId,
                  runId: run.id,
                  eventType: "text",
                  content: textChunk,
                });
              }
            }
            continue;
          }

          if (event.type === "tool_start") {
            toolStarts += 1;
            await createAgentTaskEvent(userId, taskId, run.id, {
              type: "execution_event",
              content: event.content ?? null,
              toolName: event.toolName ?? null,
              toolInput: event.toolInput,
              metadata: { eventType: "tool_start" },
            });
            send({
              type: "execution_event",
              taskId,
              runId: run.id,
              eventType: "tool_start",
              toolName: event.toolName,
              toolInput: event.toolInput,
              content: event.content,
            });
            continue;
          }

          if (event.type === "tool_result") {
            toolResults += 1;
            await createAgentTaskEvent(userId, taskId, run.id, {
              type: "execution_event",
              content: event.content ?? null,
              toolName: event.toolName ?? null,
              metadata: { eventType: "tool_result" },
            });
            send({
              type: "execution_event",
              taskId,
              runId: run.id,
              eventType: "tool_result",
              toolName: event.toolName,
              content: event.content,
            });
            continue;
          }

          if (event.type === "error") {
            hadError = true;
            errorText = event.content ?? "Agent error";
            await createAgentTaskEvent(userId, taskId, run.id, {
              type: "error",
              content: errorText,
            });
            send({
              type: "error",
              taskId,
              runId: run.id,
              content: errorText,
            });
          }
        }
      }

      const executionSummary = summarizeExecution({
        finalText,
        toolStarts,
        toolResults,
        hadError,
      });

      await createAgentArtifact(userId, taskId, run.id, {
        type: "execution_summary",
        title: "Execution summary",
        content: executionSummary,
        metadata: {
          hadError,
          toolStarts,
          toolResults,
        },
      });
      send({
        type: "artifact_created",
        taskId,
        runId: run.id,
        artifactType: "execution_summary",
      });

      if (finalText.trim()) {
        const finalResultCitations = runtimeContext.liveContext?.citations;
        await createAgentArtifact(userId, taskId, run.id, {
          type: "final_result",
          title: "Final result",
          content: finalText.trim(),
          metadata:
            finalResultCitations && finalResultCitations.length > 0
              ? { citations: finalResultCitations }
              : undefined,
        });
        send({
          type: "artifact_created",
          taskId,
          runId: run.id,
          artifactType: "final_result",
        });
        send({
          type: "final_result",
          taskId,
          runId: run.id,
          content: finalText.trim(),
          citations: finalResultCitations,
        });
      }

      if (hadError) {
        await syncExecutionPlanSteps({
          userId,
          taskId,
          executionRunId: run.id,
          planSteps: approvedPlanSteps,
          nextStatuses: buildExecutionFailureStatuses(approvedPlanSteps),
          send,
        });
        await updateAgentRunStatus(userId, run.id, "failed", {
          summary: executionSummary,
          error: errorText,
          completedAt: new Date(),
        });
        await updateAgentTaskStatus(userId, taskId, "failed");
        await syncTaskBackedMessages(userId, taskId).catch(() => undefined);
        await createAgentTaskEvent(userId, taskId, run.id, {
          type: "task_status",
          content: "Task execution failed.",
          metadata: { status: "failed" },
        });
        send({ type: "task_status", taskId, runId: run.id, status: "failed" });
      } else {
        await syncExecutionPlanSteps({
          userId,
          taskId,
          executionRunId: run.id,
          planSteps: approvedPlanSteps,
          nextStatuses: buildExecutionSuccessStatuses(approvedPlanSteps),
          send,
        });
        await updateAgentRunStatus(userId, run.id, "completed", {
          summary: executionSummary,
          completedAt: new Date(),
        });
        await updateAgentTaskStatus(userId, taskId, "completed");
        await syncTaskBackedMessages(userId, taskId).catch(() => undefined);
        await createAgentTaskEvent(userId, taskId, run.id, {
          type: "task_status",
          content: "Task execution completed.",
          metadata: { status: "completed" },
        });
        send({ type: "task_status", taskId, runId: run.id, status: "completed" });
      }

      send({ type: "done", taskId, runId: run.id });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Task execution failed";
      await syncExecutionPlanSteps({
        userId,
        taskId,
        executionRunId: run.id,
        planSteps: approvedPlanSteps,
        nextStatuses: buildExecutionFailureStatuses(approvedPlanSteps),
        send,
      }).catch(() => undefined);
      await updateAgentRunStatus(userId, run.id, "failed", {
        summary: message,
        error: message,
        completedAt: new Date(),
      }).catch(() => undefined);
      await updateAgentTaskStatus(userId, taskId, "failed").catch(() => undefined);
      await syncTaskBackedMessages(userId, taskId).catch(() => undefined);
      await createAgentTaskEvent(userId, taskId, run.id, {
        type: "error",
        content: message,
      }).catch(() => undefined);
      send({ type: "error", taskId, runId: run.id, content: message });
    }
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

agent.get("/tasks", async (c) => {
  const user = c.get("user");
  const conversationId = c.req.query("conversationId") || undefined;
  const tasks = await listAgentTasks(user.id, { conversationId });
  return c.json({ tasks });
});

agent.get("/tasks/:id", async (c) => {
  const user = c.get("user");
  const taskId = c.req.param("id");
  const task = await getAgentTaskById(user.id, taskId);
  if (!task) {
    return c.json({ error: "Task not found" }, 404);
  }
  const detail = await getAgentTaskDetail(user.id, taskId);
  return c.json(detail);
});

agent.patch("/tasks/:id", async (c) => {
  const user = c.get("user");
  const taskId = c.req.param("id");
  const task = await getAgentTaskById(user.id, taskId);
  if (!task) {
    return c.json({ error: "Task not found" }, 404);
  }

  const body = (await c.req.json().catch(() => null)) as unknown;
  if (!isRecord(body) || typeof body.goal !== "string" || !body.goal.trim()) {
    return c.json({ error: "goal is required" }, 400);
  }

  try {
    await updateAgentTask(user.id, taskId, {
      goal: body.goal,
      title: typeof body.title === "string" ? body.title : undefined,
    });
    const detail = await getAgentTaskDetail(user.id, taskId);
    return c.json(detail);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to update task";
    const status = message === "Task not found" ? 404 : 400;
    return c.json({ error: message }, status);
  }
});

agent.get("/tasks/:id/events", async (c) => {
  const user = c.get("user");
  const taskId = c.req.param("id");
  const task = await getAgentTaskById(user.id, taskId);
  if (!task) {
    return c.json({ error: "Task not found" }, 404);
  }
  const events = await listAgentTaskEvents(user.id, taskId);
  return c.json({ events });
});

agent.get("/tasks/:id/artifacts", async (c) => {
  const user = c.get("user");
  const taskId = c.req.param("id");
  const task = await getAgentTaskById(user.id, taskId);
  if (!task) {
    return c.json({ error: "Task not found" }, 404);
  }
  const artifacts = await listAgentArtifacts(user.id, taskId);
  return c.json({ artifacts });
});

agent.post("/tasks", async (c) => {
  const user = c.get("user");
  const body = (await c.req.json().catch(() => null)) as unknown;
  if (!isRecord(body) || typeof body.goal !== "string" || !body.goal.trim()) {
    return c.json({ error: "goal is required" }, 400);
  }

  const attachments = Array.isArray(body.attachments)
    ? body.attachments
        .filter((item): item is Record<string, unknown> => isRecord(item))
        .map((item) => ({
          id: typeof item.id === "string" ? item.id : undefined,
          fileName: typeof item.fileName === "string" ? item.fileName : "attachment",
          fileType: typeof item.fileType === "string" ? item.fileType : undefined,
          fileSize: typeof item.fileSize === "number" ? item.fileSize : undefined,
        }))
    : [];

  try {
    const requestedChannelId = typeof body.channelId === "string" ? body.channelId : null;
    const requestedModelId = typeof body.modelId === "string" ? body.modelId : null;
    const resolvedChannel = await getResolvedChannelForConversation(user.id, {
      channelId: requestedChannelId,
      modelId: requestedModelId,
    }).catch(() => null);
    const task = await createAgentTask(user.id, {
      conversationId: typeof body.conversationId === "string" ? body.conversationId : null,
      channelId: requestedChannelId || resolvedChannel?.channel.id || null,
      modelId: requestedModelId || resolvedChannel?.modelId || null,
      title: typeof body.title === "string" ? body.title : null,
      goal: body.goal,
      attachments,
      complexity: parseTaskComplexity(body.complexity),
      uxMode: parseTaskUxMode(body.uxMode),
      requiresPlanApproval:
        typeof body.requiresPlanApproval === "boolean" ? body.requiresPlanApproval : undefined,
      autoStart: typeof body.autoStart === "boolean" ? body.autoStart : undefined,
    });
    return c.json({ task }, 201);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Failed to create task" }, 400);
  }
});

agent.post("/tasks/:id/plan", async (c) => {
  const user = c.get("user");
  const taskId = c.req.param("id");
  const task = await getAgentTaskById(user.id, taskId);
  if (!task) {
    return c.json({ error: "Task not found" }, 404);
  }

  try {
    await updateAgentTaskStatus(user.id, taskId, "planning");
    const run = await createAgentRun(user.id, taskId, {
      phase: "planning",
      status: "running",
      startedAt: new Date(),
    });
    await createAgentTaskEvent(user.id, taskId, run.id, {
      type: "task_status",
      content: "Task entered planning.",
      metadata: { status: "planning" },
    });

    const planSteps = await setAgentPlanSteps(user.id, taskId, run.id, {
      steps: buildPlanFromTask(task),
    });

    for (const step of planSteps) {
      await createAgentTaskEvent(user.id, taskId, run.id, {
        type: "plan_step",
        content: step.title,
        metadata: {
          orderIndex: step.orderIndex,
          description: step.description,
          status: step.status,
        },
      });
    }

    if (task.requiresPlanApproval) {
      const approval = await createAgentApprovalRequest(user.id, taskId, run.id, {
        type: "plan_approval",
        title: "Approve task execution",
        description: "Review the generated plan before the agent starts executing it.",
        payload: {
          planStepIds: planSteps.map((step) => step.id),
          planStepCount: planSteps.length,
        },
      });

      await createAgentTaskEvent(user.id, taskId, run.id, {
        type: "approval_requested",
        content: approval.title,
        metadata: { approvalId: approval.id, approvalType: approval.type },
      });

      await updateAgentRunStatus(user.id, run.id, "awaiting_approval");
      await updateAgentTaskStatus(user.id, taskId, "awaiting_approval");
      await createAgentTaskEvent(user.id, taskId, run.id, {
        type: "task_status",
        content: "Task is awaiting approval.",
        metadata: { status: "awaiting_approval" },
      });
    } else {
      await updateAgentRunStatus(user.id, run.id, "completed");
      await updateAgentTaskStatus(user.id, taskId, "draft");
      await createAgentTaskEvent(user.id, taskId, run.id, {
        type: "task_status",
        content: "Task is ready to execute.",
        metadata: { status: "draft" },
      });
    }

    const detail = await getAgentTaskDetail(user.id, taskId);
    return c.json(detail);
  } catch (error) {
    await updateAgentTaskStatus(user.id, taskId, "failed").catch(() => undefined);
    return c.json({ error: error instanceof Error ? error.message : "Failed to create plan" }, 400);
  }
});

agent.post("/approvals/:id/respond", async (c) => {
  const user = c.get("user");
  const approvalId = c.req.param("id");
  const body = (await c.req.json().catch(() => null)) as unknown;
  if (!isRecord(body) || (body.status !== "approved" && body.status !== "rejected")) {
    return c.json({ error: "status must be approved or rejected" }, 400);
  }

  try {
    const approval = await respondToAgentApproval(user.id, approvalId, {
      status: body.status,
      response:
        isRecord(body.response) || Array.isArray(body.response) ? body.response : body.response,
    });

    const nextStatus =
      approval.type === "tool_approval"
        ? approval.status === "approved"
          ? "running"
          : "failed"
        : approval.status === "rejected"
          ? "draft"
          : "draft";

    await updateAgentTaskStatus(user.id, approval.taskId, nextStatus);
    await createAgentTaskEvent(user.id, approval.taskId, approval.runId, {
      type: "approval_resolved",
      content: `${approval.type} ${approval.status}`,
      metadata: { approvalId: approval.id, status: approval.status },
    });
    await createAgentTaskEvent(user.id, approval.taskId, approval.runId, {
      type: "task_status",
      content:
        approval.type === "tool_approval"
          ? approval.status === "approved"
            ? "Task resumed after tool approval."
            : "Task failed because the tool approval was rejected."
          : approval.status === "approved"
            ? "Task is ready to execute."
            : "Task returned to draft after plan rejection.",
      metadata: { status: nextStatus, approvalId: approval.id, approvalType: approval.type },
    });

    const detail = await getAgentTaskDetail(user.id, approval.taskId);
    return c.json(detail);
  } catch (error) {
    const status = error instanceof Error && error.message === "Approval not found" ? 404 : 400;
    return c.json(
      { error: error instanceof Error ? error.message : "Failed to respond to approval" },
      status,
    );
  }
});

agent.post("/tasks/:id/execute", async (c) => {
  const user = c.get("user");
  const taskId = c.req.param("id");
  return createTaskExecutionResponse(user.id, taskId, "execute");
});

agent.post("/tasks/:id/retry", async (c) => {
  const user = c.get("user");
  const taskId = c.req.param("id");
  return createTaskExecutionResponse(user.id, taskId, "retry");
});

agent.post("/tasks/:id/continue", async (c) => {
  const user = c.get("user");
  const taskId = c.req.param("id");
  return createTaskExecutionResponse(user.id, taskId, "continue");
});

agent.post("/tasks/:id/cancel", async (c) => {
  const user = c.get("user");
  const taskId = c.req.param("id");
  const task = await getAgentTaskById(user.id, taskId);
  if (!task) {
    return c.json({ error: "Task not found" }, 404);
  }
  await updateAgentTaskStatus(user.id, taskId, "cancelled");
  const detail = await getAgentTaskDetail(user.id, taskId);
  return c.json(detail);
});

agent.get("/sessions", async (c) => {
  const user = c.get("user");

  const sessions = await getAgentSessions(user.id);
  return c.json({ sessions });
});

agent.get("/sessions/:id/events", async (c) => {
  const user = c.get("user");

  const sessionId = c.req.param("id");
  const events = await getAgentEvents(user.id, sessionId);
  return c.json({ events });
});

agent.delete("/events/:eventId", async (c) => {
  const user = c.get("user");
  const eventId = c.req.param("eventId");
  const ok = await deleteAgentEvent(user.id, eventId);
  if (!ok) return c.json({ error: "Not found" }, 404);
  return c.json({ success: true });
});

agent.get("/sessions/:id", async (c) => {
  const user = c.get("user");

  const sessionId = c.req.param("id");
  const session = await getAgentSessionById(user.id, sessionId);

  if (!session) {
    return c.json({ error: "Session not found" }, 404);
  }

  return c.json({ session });
});

agent.post("/sessions", async (c) => {
  const user = c.get("user");

  try {
    const body = await c.req.json();
    const session = await createAgentSession(user.id, body);
    return c.json({ session }, 201);
  } catch (error) {
    return c.json(
      {
        error: error instanceof Error ? error.message : "Failed to create session",
      },
      400,
    );
  }
});

agent.post("/sessions/:id/run", async (c) => {
  const user = c.get("user");

  const sessionId = c.req.param("id");
  const session = await getAgentSessionById(user.id, sessionId);
  if (!session) {
    return c.text("Session not found", 404);
  }

  const body = (await c.req.json().catch(() => null)) as unknown;
  if (!isRecord(body)) {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const prompt = body.prompt;
  const attachmentsRaw = body.attachments;

  const hasPrompt = typeof prompt === "string" && prompt.trim().length > 0;
  const attachments = Array.isArray(attachmentsRaw)
    ? attachmentsRaw.filter(
        (value): value is string => typeof value === "string" && value.trim().length > 0,
      )
    : [];
  const hasAttachments = attachments.length > 0;
  if (!hasPrompt && !hasAttachments) {
    return c.json({ error: "prompt or attachments are required" }, 400);
  }

  // Fail fast before opening the SSE stream when the configured channel/model
  // cannot actually run Claude Agent SDK, regardless of provider naming.
  const runtimeResolution = await resolveAgentRuntime({
    userId: user.id,
    requestedChannelId: session.channelId || null,
    requestedModelId: session.modelId || null,
    bypassCache: true,
  });
  if (runtimeResolution.success === false) {
    return c.text(runtimeResolution.error, 400);
  }

  const stream = createSseStream(async (send, ctx) => {
    const timeoutGuard = createAgentStreamTimeoutGuard(ctx.abortController);

    try {
      for await (const event of runAgent(
        user.id,
        sessionId,
        typeof prompt === "string" ? prompt : "",
        attachments,
        ctx.abortController,
      )) {
        if (event.type === "meta") {
          timeoutGuard.markActivity?.();
        } else {
          timeoutGuard.markVisibleOutput();
        }
        send(event);
      }
    } finally {
      timeoutGuard.cleanup();
    }
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
});

agent.put("/sessions/:id/channel", async (c) => {
  const user = c.get("user");

  const sessionId = c.req.param("id");
  const body = await c.req.json();
  const { channelId, modelId } = body;
  if (!channelId || !modelId) {
    return c.json({ error: "channelId and modelId are required" }, 400);
  }

  await updateAgentSessionChannel(user.id, sessionId, channelId, modelId);
  return c.json({ success: true });
});

agent.put("/sessions/:id/status", async (c) => {
  const user = c.get("user");

  const sessionId = c.req.param("id");
  const body = await c.req.json();
  const { status } = body;

  await updateAgentSessionStatus(user.id, sessionId, status);
  return c.json({ success: true });
});

agent.put("/sessions/:id", async (c) => {
  const user = c.get("user");

  try {
    const sessionId = c.req.param("id");
    const body = await c.req.json();
    const title = body?.title;
    if (typeof title !== "string" || !title.trim()) {
      return c.json({ error: "title is required" }, 400);
    }

    await renameAgentSession(user.id, sessionId, title);
    return c.json({ success: true });
  } catch (error) {
    if (error instanceof Error && error.message === "Session not found") {
      return c.json({ error: "Session not found" }, 404);
    }
    return c.json(
      {
        error: error instanceof Error ? error.message : "Failed to update session",
      },
      400,
    );
  }
});

agent.delete("/sessions/:id", async (c) => {
  const user = c.get("user");

  try {
    const sessionId = c.req.param("id");
    await deleteAgentSession(user.id, sessionId);
    return c.json({ success: true });
  } catch (error) {
    if (error instanceof Error && error.message === "Session not found") {
      return c.json({ error: "Session not found" }, 404);
    }
    return c.json(
      { error: error instanceof Error ? error.message : "Failed to delete session" },
      400,
    );
  }
});

agent.post("/sessions/:id/auto-title", async (c) => {
  const user = c.get("user");

  try {
    const sessionId = c.req.param("id");
    const session = await getAgentSessionById(user.id, sessionId);
    if (!session) {
      return c.json({ error: "Session not found" }, 404);
    }
    const body = await c.req.json().catch(() => ({}));
    const prompt = typeof body.prompt === "string" ? body.prompt : "";
    if (!prompt.trim()) {
      return c.json({ error: "prompt is required" }, 400);
    }
    const title = await generateAutoTitle(user.id, prompt, session.channelId || null);
    if (!title) {
      return c.json({ success: false, error: "Failed to generate title" });
    }
    await renameAgentSession(user.id, sessionId, title);
    return c.json({ success: true, title });
  } catch (error) {
    return c.json({ success: false, error: error instanceof Error ? error.message : "Failed" });
  }
});

  return agent;
}

const agent = createAgentRouter();

export default agent;
