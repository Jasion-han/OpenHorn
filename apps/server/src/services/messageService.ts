import { attachments, conversations, messages } from "db";
import { and, asc, eq, inArray } from "drizzle-orm";
import { type ChatContentPart, type ChatMessage, createAdapter } from "../agent-adapters";
import { buildTaskMessageSummary } from "./agentTaskMessage";
import { db } from "../db";
import { generateId } from "../utils";
import { createSseStream } from "../utils/sse";
import { type AgentRuntimeConfig, runAgentWithConfig } from "./agentService";
import { mergeAgentTextOutput } from "./agentSdk";
import type {
  AgentTaskComplexity,
  AgentTaskDetail,
  AgentTaskRecord,
  AgentTaskUxMode,
} from "./agentTaskService";
import { buildAttachmentPayloadFromIds, linkAttachmentsToMessage } from "./attachmentService";
import {
  getAgentCapabilityModeFromSuccessResult,
  resolveAgentRuntime,
} from "./channelAgentCheckService";
import { getResolvedChannelForConversation } from "./channelService";
import { createAgentStreamTimeoutGuard } from "./agentStreamTimeouts";
import { buildAgentPlan } from "./agentPlanBuilder";
import { buildLiveContext, type LiveContextResult, toStoredLiveMetadata } from "./liveCapabilities";
import { mergeSystemPromptParts, RESPONSE_STYLE_GUARDRAILS } from "./responseStyle";
import { classifyLiveRouteWithModel } from "./liveRouteClassifier";
import {
  type SearchCitation,
  TAVILY_API_KEY_SETTING,
  TAVILY_ENABLED_SETTING,
} from "./searchService";
import { getSettingValues } from "./settingsService";

const GLOBAL_SYSTEM_PROMPT_KEY = "chat.systemPrompt";
const AGENT_RECENT_CONTEXT_LIMIT = 8;
const AGENT_DEFAULT_COMPLEXITY_SETTING = "agent.defaultComplexity";
const AGENT_DEFAULT_UX_MODE_SETTING = "agent.defaultUxMode";
const AGENT_DEFAULT_REQUIRES_PLAN_APPROVAL_SETTING = "agent.defaultRequiresPlanApproval";
const AGENT_DEFAULT_AUTO_START_SETTING = "agent.defaultAutoStart";

async function loadAgentTaskService() {
  return import("./agentTaskService");
}
export interface SendMessageInput {
  conversationId: string;
  content: string;
  attachments?: string[];
  mode?: "chat" | "agent";
}

export interface StreamMessageInput {
  conversationId: string;
  content: string;
  attachments?: string[];
  mode?: "chat" | "agent";
  /**
   * Per-message overrides for agent task creation. When present, these
   * take priority over the user's stored AgentSettings defaults. This
   * lets the desktop Composer provide ephemeral per-task controls
   * ("计划审批" / "深度思考") without altering the global defaults.
   */
  agentOverrides?: {
    complexity?: "light" | "standard" | "deep";
    requiresPlanApproval?: boolean;
  };
}

type AgentRunStep = {
  type: "tool_start" | "tool_result" | "error";
  toolName?: string;
  content?: string;
  toolInput?: unknown;
};

type AgentRunData = {
  status: "running" | "awaiting_approval" | "completed" | "failed" | "cancelled" | "partial";
  summary: string;
  error?: string;
  steps: AgentRunStep[];
  toolCount?: number;
  taskId?: string;
  complexity?: "light" | "standard" | "deep";
  uxMode?: "direct" | "compact" | "full";
  requiresPlanApproval?: boolean;
  autoStart?: boolean;
  taskStatus?:
    | "draft"
    | "planning"
    | "awaiting_approval"
    | "running"
    | "completed"
    | "failed"
    | "cancelled";
  latestRunId?: string | null;
  latestRunPhase?: "planning" | "execution" | null;
  latestApprovalId?: string | null;
  latestApprovalType?: "plan_approval" | "tool_approval" | null;
  latestApprovalStatus?: "pending" | "approved" | "rejected" | null;
};

type LiveStatusPayload = {
  type: "live_status";
  status: "live" | "offline";
  route: "local" | "structured_live" | "web_search" | "research" | "direct_model";
  label?: string;
};

type CitationsPayload = {
  type: "citations";
  citations: SearchCitation[];
};

type AgentTaskDefaults = {
  complexity: AgentTaskComplexity;
  uxMode: AgentTaskUxMode;
  requiresPlanApproval: boolean;
  autoStart: boolean;
};

function parseBooleanSetting(value: string | undefined, fallback: boolean) {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  return fallback;
}

function parseAgentTaskComplexity(
  value: string | undefined,
  fallback: AgentTaskComplexity,
): AgentTaskComplexity {
  if (value === "light" || value === "standard" || value === "deep") return value;
  return fallback;
}

function parseAgentTaskUxMode(
  value: string | undefined,
  fallback: AgentTaskUxMode,
): AgentTaskUxMode {
  if (value === "direct" || value === "compact" || value === "full") return value;
  return fallback;
}

function getAgentTaskDefaults(settings: Record<string, string>): AgentTaskDefaults {
  return {
    complexity: parseAgentTaskComplexity(settings[AGENT_DEFAULT_COMPLEXITY_SETTING], "standard"),
    uxMode: parseAgentTaskUxMode(settings[AGENT_DEFAULT_UX_MODE_SETTING], "compact"),
    requiresPlanApproval: parseBooleanSetting(
      settings[AGENT_DEFAULT_REQUIRES_PLAN_APPROVAL_SETTING],
      false,
    ),
    autoStart: parseBooleanSetting(settings[AGENT_DEFAULT_AUTO_START_SETTING], true),
  };
}

function buildTaskPlan(task: Pick<AgentTaskRecord, "goal" | "complexity" | "attachments">) {
  return buildAgentPlan({
    goal: task.goal,
    complexity: task.complexity,
    attachments: task.attachments,
  });
}

function buildTaskBackedAgentRun(detail: AgentTaskDetail): AgentRunData {
  const latestRun = detail.runs[0] ?? null;
  const latestApproval = detail.approvals[0] ?? null;
  const toolCount = detail.events.filter(
    (event) =>
      event.type === "execution_event" &&
      event.metadata &&
      typeof event.metadata === "object" &&
      !Array.isArray(event.metadata) &&
      (event.metadata as Record<string, unknown>).eventType === "tool_start",
  ).length;

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
    toolCount,
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

function parseAgentRunData(value: string | null | undefined): AgentRunData | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as AgentRunData;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function getTaskFinalResultCitations(detail: AgentTaskDetail) {
  const finalResult = detail.artifacts.find((artifact) => artifact.type === "final_result") ?? null;
  if (!finalResult?.metadata || typeof finalResult.metadata !== "object" || Array.isArray(finalResult.metadata)) {
    return undefined;
  }

  const citations = (finalResult.metadata as Record<string, unknown>).citations;
  return Array.isArray(citations) ? citations : undefined;
}

export async function syncTaskBackedMessages(userId: string, taskId: string): Promise<void> {
  const { getAgentTaskDetail } = await loadAgentTaskService();
  const detail = await getAgentTaskDetail(userId, taskId);
  const conversationId = detail.task.conversationId;
  if (!conversationId) return;

  const candidateMessages = await db
    .select({
      id: messages.id,
      agentRun: messages.agentRun,
    })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, conversationId),
        eq(messages.role, "assistant"),
        eq(messages.mode, "agent"),
      ),
    );

  const targetIds = candidateMessages
    .filter((message) => parseAgentRunData(message.agentRun)?.taskId === taskId)
    .map((message) => message.id);

  if (targetIds.length === 0) return;

  await db
    .update(messages)
    .set({
      content: buildTaskMessageSummary(detail),
      agentRun: JSON.stringify(buildTaskBackedAgentRun(detail)),
      citations: (() => {
        const citations = getTaskFinalResultCitations(detail);
        return citations && citations.length > 0 ? JSON.stringify(citations) : null;
      })(),
      liveMetadata: null,
    })
    .where(inArray(messages.id, targetIds));
}

async function planTaskForTurn(userId: string, task: AgentTaskRecord) {
  const {
    createAgentApprovalRequest,
    createAgentRun,
    createAgentTaskEvent,
    getAgentTaskDetail,
    setAgentPlanSteps,
    updateAgentRunStatus,
    updateAgentTaskStatus,
  } = await loadAgentTaskService();
  await updateAgentTaskStatus(userId, task.id, "planning");
  const run = await createAgentRun(userId, task.id, {
    phase: "planning",
    status: "running",
    startedAt: new Date(),
  });
  await createAgentTaskEvent(userId, task.id, run.id, {
    type: "task_status",
    content: "Task entered planning.",
    metadata: { status: "planning" },
  });

  const planSteps = await setAgentPlanSteps(userId, task.id, run.id, {
    steps: buildTaskPlan(task),
  });

  for (const step of planSteps) {
    await createAgentTaskEvent(userId, task.id, run.id, {
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
    const approval = await createAgentApprovalRequest(userId, task.id, run.id, {
      type: "plan_approval",
      title: "Approve task execution",
      description: "Review the generated plan before the agent starts executing it.",
      payload: {
        planStepIds: planSteps.map((step) => step.id),
        planStepCount: planSteps.length,
      },
    });

    await createAgentTaskEvent(userId, task.id, run.id, {
      type: "approval_requested",
      content: approval.title,
      metadata: { approvalId: approval.id, approvalType: approval.type },
    });
    await updateAgentRunStatus(userId, run.id, "awaiting_approval");
    await updateAgentTaskStatus(userId, task.id, "awaiting_approval");
    await createAgentTaskEvent(userId, task.id, run.id, {
      type: "task_status",
      content: "Task is awaiting approval.",
      metadata: { status: "awaiting_approval" },
    });
  } else {
    await updateAgentRunStatus(userId, run.id, "completed");
    await updateAgentTaskStatus(userId, task.id, "draft");
    await createAgentTaskEvent(userId, task.id, run.id, {
      type: "task_status",
      content: "Task is ready to execute.",
      metadata: { status: "draft" },
    });
  }

  return getAgentTaskDetail(userId, task.id);
}

async function createTaskBackedAgentTurn(params: {
  userId: string;
  conversationId: string;
  conversation: Awaited<ReturnType<typeof getConversationForUser>>;
  prompt: string;
  attachmentIds?: string[];
  agentOverrides?: StreamMessageInput["agentOverrides"];
}) {
  const { createAgentTask } = await loadAgentTaskService();
  const resolvedChannel = await getResolvedChannelForConversation(params.userId, {
    channelId: params.conversation.channelId || null,
    modelId: params.conversation.modelId || null,
  });
  const settings = await getSettingValues(params.userId, [
    AGENT_DEFAULT_COMPLEXITY_SETTING,
    AGENT_DEFAULT_UX_MODE_SETTING,
    AGENT_DEFAULT_REQUIRES_PLAN_APPROVAL_SETTING,
    AGENT_DEFAULT_AUTO_START_SETTING,
  ]);
  const defaults = getAgentTaskDefaults(settings);

  // Per-message overrides (from the Composer's per-task switches)
  // take precedence over the user's stored defaults.
  const complexity = params.agentOverrides?.complexity ?? defaults.complexity;
  const requiresPlanApproval =
    params.agentOverrides?.requiresPlanApproval ?? defaults.requiresPlanApproval;

  const task = await createAgentTask(params.userId, {
    conversationId: params.conversationId,
    channelId: params.conversation.channelId || resolvedChannel?.channel.id || null,
    modelId: params.conversation.modelId || resolvedChannel?.modelId || null,
    title: null,
    goal: params.prompt,
    attachments: (params.attachmentIds || []).map((id) => ({
      id,
      fileName: "attachment",
    })),
    complexity,
    uxMode: defaults.uxMode,
    requiresPlanApproval,
    autoStart: true,
  });
  const detail = await planTaskForTurn(params.userId, task);

  return {
    detail,
    content: buildTaskMessageSummary(detail),
    agentRun: buildTaskBackedAgentRun(detail),
    modelId: detail.task.modelId,
  };
}

async function applyTaskBackedAgentTurnToMessage(params: {
  userId: string;
  conversation: Awaited<ReturnType<typeof getConversationForUser>>;
  conversationId: string;
  assistantMessageId: string;
  prompt: string;
  attachmentIds?: string[];
  workspaceId?: string | null;
  contextPaths?: string[];
  agentOverrides?: StreamMessageInput["agentOverrides"];
}) {
  let turn: Awaited<ReturnType<typeof createTaskBackedAgentTurn>>;
  try {
    turn = await createTaskBackedAgentTurn({
      userId: params.userId,
      conversationId: params.conversationId,
      conversation: params.conversation,
      prompt: params.prompt,
      attachmentIds: params.attachmentIds,
      agentOverrides: params.agentOverrides,
    });
  } catch (error) {
    // The caller set conversations.runStatus to "running" before this turn.
    // If the turn throws (model/network failure), the success-path reset below
    // never runs and the conversation is stuck showing "running" forever.
    // Reset to "failed" so the UI unsticks; best-effort so the original error
    // still propagates to the SSE error handler.
    try {
      await db
        .update(conversations)
        .set({ updatedAt: new Date(), runStatus: "failed" })
        .where(eq(conversations.id, params.conversationId));
    } catch {
      // ignore — surfacing the original turn error matters more
    }
    throw error;
  }
  const { detail, content, agentRun, modelId } = turn;

  await db
    .update(messages)
    .set({
      content,
      model: modelId,
      mode: "agent",
      workspaceId: params.workspaceId ?? null,
      contextPaths:
        params.contextPaths && params.contextPaths.length > 0
          ? JSON.stringify(params.contextPaths)
          : null,
      agentRun: JSON.stringify(agentRun),
      liveMetadata: null,
      citations: null,
    })
    .where(eq(messages.id, params.assistantMessageId));

  await db
    .update(conversations)
    .set({
      updatedAt: new Date(),
      workspaceId: params.workspaceId ?? null,
      lastMode: "agent",
      runStatus: detail.task.status,
    })
    .where(eq(conversations.id, params.conversationId));

  return { detail, content, agentRun, modelId };
}

function parseJsonArray(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function normalizeChatContent(
  content: string | ChatContentPart[],
): string | ChatContentPart[] | null {
  if (typeof content === "string") {
    const text = content.trim();
    return text ? text : null;
  }

  const parts = content
    .filter((part) => {
      if (part.type === "image") return true;
      return Boolean(part.text?.trim());
    })
    .map((part) => {
      if (part.type === "image") return part;
      return { ...part, text: part.text.trim() };
    });

  return parts.length > 0 ? parts : null;
}

function mergeChatContent(
  left: string | ChatContentPart[],
  right: string | ChatContentPart[],
): string | ChatContentPart[] {
  if (typeof left === "string" && typeof right === "string") {
    return `${left}\n\n${right}`;
  }

  const asParts = (value: string | ChatContentPart[]): ChatContentPart[] => {
    if (typeof value === "string") {
      return [{ type: "text", text: value }];
    }
    return value;
  };

  return [...asParts(left), { type: "text", text: "\n\n" }, ...asParts(right)];
}

function appendChatMessage(
  chatMessages: ChatMessage[],
  role: ChatMessage["role"],
  content: string | ChatContentPart[],
) {
  const normalized = normalizeChatContent(content);
  if (!normalized) return;

  const last = chatMessages[chatMessages.length - 1];
  if (last && last.role === role) {
    last.content = mergeChatContent(last.content, normalized);
    return;
  }

  chatMessages.push({ role, content: normalized });
}

function buildAgentRunSummary(steps: AgentRunStep[], error?: string) {
  const toolCount = steps.filter((step) => step.type === "tool_start").length;
  if (error) {
    return toolCount > 0 ? `Agent 运行失败，已调用 ${toolCount} 个工具` : "Agent 运行失败";
  }
  return toolCount > 0 ? `Agent 已调用 ${toolCount} 个工具` : "Agent 已完成本轮执行";
}

function buildEffectiveSystemPrompt(
  systemPrompt: string | null | undefined,
  liveContext: LiveContextResult,
) {
  return mergeSystemPromptParts(systemPrompt, RESPONSE_STYLE_GUARDRAILS, liveContext.systemContext);
}

function buildLiveStatusPayload(liveContext: LiveContextResult): LiveStatusPayload {
  return {
    type: "live_status",
    status: liveContext.status,
    route: liveContext.route,
    label: liveContext.userLabel,
  };
}

function serializeLiveMetadata(liveContext: LiveContextResult) {
  return JSON.stringify(toStoredLiveMetadata(liveContext));
}

function serializeCitations(citations?: SearchCitation[]) {
  return citations && citations.length > 0 ? JSON.stringify(citations) : null;
}

function buildCitationsPayload(citations?: SearchCitation[]): CitationsPayload | null {
  if (!citations || citations.length === 0) return null;
  return {
    type: "citations",
    citations,
  };
}

function buildRecentAgentConversationHistory(
  conversationMessages: Array<{ role: string; content: string | null | undefined }>,
  limit = AGENT_RECENT_CONTEXT_LIMIT,
): NonNullable<AgentRuntimeConfig["conversationHistory"]> {
  return conversationMessages
    .filter(
      (
        message,
      ): message is {
        role: "user" | "assistant";
        content: string;
      } => {
        if (message.role !== "user" && message.role !== "assistant") return false;
        if (typeof message.content !== "string") return false;
        const content = message.content.trim();
        if (!content) return false;
        if (message.role === "assistant" && /^Error:\s*/i.test(content)) return false;
        return true;
      },
    )
    .slice(-limit)
    .map((message) => ({
      role: message.role,
      content: message.content.trim(),
    }));
}

function excludeCurrentPromptFromHistory(
  history: NonNullable<AgentRuntimeConfig["conversationHistory"]>,
  prompt: string,
) {
  const trimmedPrompt = prompt.trim();
  if (!trimmedPrompt || history.length === 0) return history;
  const last = history[history.length - 1];
  if (last?.role === "user" && last.content === trimmedPrompt) {
    return history.slice(0, -1);
  }
  return history;
}

async function runAgentAndStream({
  send,
  config,
}: {
  send: (payload: Record<string, unknown>) => void;
  config: Parameters<typeof runAgentWithConfig>[0];
}): Promise<{ responseContent: string; agentRun: AgentRunData }> {
  let responseContent = "";
  let agentError: string | undefined;
  const steps: AgentRunStep[] = [];
  const abortController = config.abortController || new AbortController();
  const timeoutGuard = createAgentStreamTimeoutGuard(abortController);

  try {
    for await (const event of runAgentWithConfig({ ...config, abortController })) {
      if (event.type === "meta") {
        timeoutGuard.markActivity?.();
      } else {
        timeoutGuard.markVisibleOutput();
      }

      if (event.type === "thought") {
        steps.push({
          type: "tool_result",
          toolName: "Thinking",
          content: event.content,
        });
        send({ type: "agent_event", event });
        continue;
      }

      if (event.type === "text") {
        const chunk = event.content || "";
        if (!chunk) continue;
        responseContent = mergeAgentTextOutput(responseContent, chunk);
        send({ type: "delta", content: chunk });
        continue;
      }

      if (event.type === "tool_start" || event.type === "tool_result") {
        steps.push({
          type: event.type,
          toolName: event.toolName,
          content: event.content,
          toolInput: event.toolInput,
        });
        send({ type: "agent_event", event });
        continue;
      }

      if (event.type === "error") {
        agentError = event.content || "Agent error";
        steps.push({ type: "error", content: agentError });
        send({ type: "agent_event", event });
      }
    }
  } finally {
    timeoutGuard.cleanup();
  }

  const agentRun: AgentRunData = {
    status: agentError ? "failed" : "completed",
    summary: buildAgentRunSummary(steps, agentError),
    error: agentError,
    steps,
  };

  return { responseContent, agentRun };
}

async function streamConversationAgentReply(params: {
  userId: string;
  send: (payload: Record<string, unknown>) => void;
  conversationId: string;
  prompt: string;
  attachmentIds?: string[];
  channelId?: string | null;
  modelId?: string | null;
  forceWebSearch?: boolean | null;
  abortController?: AbortController;
  conversationHistory?: Array<{
    role: string;
    content: string | null | undefined;
  }>;
}) {
  const runtimeResolution = await resolveAgentRuntime({
    userId: params.userId,
    requestedChannelId: params.channelId ?? null,
    requestedModelId: params.modelId ?? null,
    bypassCache: true,
  });
  const resolvedChannel = runtimeResolution.success ? runtimeResolution.resolvedChannel : null;
  const effectiveModelId = resolvedChannel?.modelId ?? params.modelId ?? null;
  const failImmediately = (
    error: string,
  ): {
    responseContent: string;
    agentRun: AgentRunData;
    modelId: string | null;
    liveMetadata: null;
    citations: null;
  } => {
    params.send({ type: "agent_event", event: { type: "error", content: error } });
    params.send({ type: "delta", content: `Error: ${error}` });

    const steps: AgentRunStep[] = [{ type: "error", content: error }];
    const agentRun: AgentRunData = {
      status: "failed",
      summary: buildAgentRunSummary(steps, error),
      error,
      steps,
    };
    return {
      responseContent: `Error: ${error}`,
      agentRun,
      modelId: effectiveModelId,
      liveMetadata: null,
      citations: null,
    };
  };

  if (!resolvedChannel) {
    return failImmediately(
      runtimeResolution.success === false
        ? runtimeResolution.error
        : "未配置可用的默认渠道/默认模型。请先在设置中完成配置。",
    );
  }
  const successfulResolution = runtimeResolution as Extract<
    Awaited<ReturnType<typeof resolveAgentRuntime>>,
    { success: true }
  >;

  const settingsPromise = getSettingValues(params.userId, [
    GLOBAL_SYSTEM_PROMPT_KEY,
    TAVILY_API_KEY_SETTING,
    TAVILY_ENABLED_SETTING,
  ]);
  const settings = await settingsPromise;
  const compatibility = successfulResolution.compatibility;
  const classifier = resolvedChannel
    ? (prompt: string) =>
        classifyLiveRouteWithModel({
          protocol: resolvedChannel.channel.protocol,
          apiKey: resolvedChannel.apiKey,
          baseUrl: resolvedChannel.channel.baseUrl,
          modelId: resolvedChannel.modelId,
          prompt,
        })
    : undefined;
  // When the user's prompt clearly targets the local workspace (mentions
  // "仓库", "repo", "项目", etc.), suppress live web search even if
  // forceWebSearch is on. The route classifier sometimes mis-classifies
  // these as needing web_search because topic keywords look research-y,
  // causing the agent to waste time fetching irrelevant web results
  // instead of inspecting the workspace directly.
  const promptTargetsWorkspace =
    /(仓库|代码库|工作区|项目|源码|目录|repo|repository|codebase|workspace|readme|package\.json|tsconfig|src\/|apps\/)/i.test(
      params.prompt,
    );
  const liveContext = await buildLiveContext({
    prompt: params.prompt,
    userSettings: settings,
    tavilyEnvKey: process.env.TAVILY_API_KEY ?? null,
    forceWebSearch: promptTargetsWorkspace
      ? false
      : params.forceWebSearch == null
        ? true
        : Boolean(params.forceWebSearch),
    classifier,
  });

  params.send(buildLiveStatusPayload(liveContext));
  const citationsPayload = buildCitationsPayload(liveContext.citations);
  if (citationsPayload) {
    params.send(citationsPayload);
  }

  const { responseContent: streamedContent, agentRun } = await runAgentAndStream({
    send: params.send,
    config: {
      userId: params.userId,
      prompt: params.prompt,
      conversationHistory: excludeCurrentPromptFromHistory(
        buildRecentAgentConversationHistory(params.conversationHistory || []),
        params.prompt,
      ),
      attachmentIds: params.attachmentIds || [],
      channelId: params.channelId ?? resolvedChannel?.channel.id ?? null,
      modelId: params.modelId ?? resolvedChannel?.modelId ?? null,
      capabilityMode: getAgentCapabilityModeFromSuccessResult(
        compatibility,
        resolvedChannel?.channel.protocol,
      ),
      globalSystemPrompt: settings[GLOBAL_SYSTEM_PROMPT_KEY] || undefined,
      liveSystemContext: liveContext.systemContext,
      abortController: params.abortController,
    },
  });

  let responseContent = streamedContent;
  if (!responseContent.trim() && agentRun.error) {
    responseContent = `Error: ${agentRun.error}`;
    params.send({ type: "delta", content: responseContent });
  }

  return {
    responseContent,
    agentRun,
    modelId: effectiveModelId,
    liveMetadata: serializeLiveMetadata(liveContext),
    citations: serializeCitations(liveContext.citations),
  };
}

async function buildUserContentWithAttachments(
  userId: string,
  content: string,
  attachmentIds?: string[],
) {
  if (!attachmentIds || attachmentIds.length === 0) {
    return content;
  }

  const payload = await buildAttachmentPayloadFromIds(attachmentIds, userId);
  const images = payload.images || [];
  const ctx = payload.textContext || "";

  let text = content || "";
  if (ctx) {
    text = text.trim() ? `${text}\n\n${ctx}` : ctx;
  }
  if (!text.trim() && images.length > 0) {
    text = "Please analyze the attached image(s).";
  }

  if (images.length === 0) {
    return text;
  }

  const parts: ChatContentPart[] = [{ type: "text", text }];
  for (const img of images) {
    parts.push({
      type: "image",
      mediaType: img.fileType,
      dataBase64: img.dataBase64,
      fileName: img.fileName,
    });
  }
  return parts;
}

async function buildChatMessages(
  userId: string,
  conversationMessages: Array<{ role: string; content: string; attachments?: string | null }>,
  systemPrompt?: string | null,
): Promise<ChatMessage[]> {
  const chatMessages: ChatMessage[] = [];

  if (systemPrompt) {
    appendChatMessage(chatMessages, "system", systemPrompt);
  }

  for (const message of conversationMessages) {
    if (message.role === "user" && message.attachments) {
      let attachmentIds: string[] = [];
      try {
        attachmentIds = JSON.parse(message.attachments) as string[];
      } catch {
        attachmentIds = [];
      }

      const content = await buildUserContentWithAttachments(userId, message.content, attachmentIds);
      appendChatMessage(chatMessages, "user", content);
      continue;
    }

    appendChatMessage(chatMessages, message.role as ChatMessage["role"], message.content);
  }

  return chatMessages;
}

async function getConversationForUser(userId: string, conversationId: string) {
  const result = await db
    .select()
    .from(conversations)
    .where(and(eq(conversations.id, conversationId), eq(conversations.userId, userId)))
    .limit(1);

  if (result.length === 0) {
    throw new Error("Conversation not found");
  }

  return result[0];
}

export async function getMessages(conversationId: string) {
  const result = await db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(asc(messages.createdAt));

  return result;
}

export async function getMessagesForUser(userId: string, conversationId: string) {
  // Ownership guard: prevent cross-user reads of messages by guessing conversationId.
  await getConversationForUser(userId, conversationId);
  return getMessages(conversationId);
}

export async function getMessagesForUserWithAttachments(userId: string, conversationId: string) {
  // Ownership guard
  await getConversationForUser(userId, conversationId);
  let result = await getMessages(conversationId);

  const taskIds = Array.from(
    new Set(
      result
        .filter((message) => message.role === "assistant" && message.mode === "agent")
        .map((message) => parseAgentRunData(message.agentRun)?.taskId)
        .filter((taskId): taskId is string => typeof taskId === "string" && taskId.trim().length > 0),
    ),
  );

  if (taskIds.length > 0) {
    await Promise.allSettled(taskIds.map((taskId) => syncTaskBackedMessages(userId, taskId)));
    result = await getMessages(conversationId);
  }

  const messageIds = result.map((m) => m.id);
  if (messageIds.length === 0) return result;

  const rows = await db
    .select({
      id: attachments.id,
      messageId: attachments.messageId,
      fileName: attachments.fileName,
      fileType: attachments.fileType,
      fileSize: attachments.fileSize,
    })
    .from(attachments)
    .where(inArray(attachments.messageId, messageIds));

  const byMessage = new Map<
    string,
    Array<{ id: string; fileName: string; fileType: string; fileSize: number }>
  >();
  for (const row of rows) {
    const mid = row.messageId;
    if (!mid) continue;
    const list = byMessage.get(mid) || [];
    list.push({
      id: row.id,
      fileName: row.fileName,
      fileType: row.fileType,
      fileSize: row.fileSize,
    });
    byMessage.set(mid, list);
  }

  return result.map((m) => ({
    ...m,
    attachmentsMeta: byMessage.get(m.id) || [],
  }));
}

export async function sendMessage(userId: string, input: SendMessageInput) {
  const conversation = await getConversationForUser(userId, input.conversationId);

  const userMessageId = generateId();
  const now = new Date();

  await db.insert(messages).values({
    id: userMessageId,
    conversationId: input.conversationId,
    role: "user",
    content: input.content,
    mode: input.mode || "chat",
    attachments: input.attachments ? JSON.stringify(input.attachments) : null,
    agentRun: null,
    createdAt: now,
  });

  if (input.attachments?.length) {
    await linkAttachmentsToMessage(input.attachments, userMessageId, userId);
  }

  await db
    .update(conversations)
    .set({ updatedAt: now })
    .where(eq(conversations.id, input.conversationId));

  const resolvedChannel = await getResolvedChannelForConversation(userId, conversation);
  const settings = await getSettingValues(userId, [TAVILY_API_KEY_SETTING, TAVILY_ENABLED_SETTING]);
  const classifier = resolvedChannel
    ? (prompt: string) =>
        classifyLiveRouteWithModel({
          protocol: resolvedChannel.channel.protocol,
          apiKey: resolvedChannel.apiKey,
          baseUrl: resolvedChannel.channel.baseUrl,
          modelId: resolvedChannel.modelId,
          prompt,
        })
    : undefined;

  const conversationMessages = await getMessages(input.conversationId);
  const liveContext = await buildLiveContext({
    prompt: input.content,
    userSettings: settings,
    tavilyEnvKey: process.env.TAVILY_API_KEY ?? null,
    forceWebSearch: Boolean(conversation.forceWebSearch),
    classifier,
  });
  const chatMessages = await buildChatMessages(
    userId,
    conversationMessages,
    buildEffectiveSystemPrompt(conversation.systemPrompt, liveContext),
  );

  let responseContent = "";
  let responseModel: string | null = null;

  if (resolvedChannel) {
    const adapter = createAdapter(
      resolvedChannel.channel.protocol,
      resolvedChannel.apiKey,
      resolvedChannel.channel.baseUrl || undefined,
    );
    responseModel = resolvedChannel.modelId;

    // Mirror the streaming path (streamMessage): if the provider throws mid-turn,
    // persist an "Error:" assistant reply below instead of throwing and leaving a
    // dangling user message with no assistant row for this turn.
    try {
      const stream = await adapter.chatStream({
        model: resolvedChannel.modelId,
        messages: chatMessages,
        maxTokens: 4096,
      });

      for await (const chunk of stream) {
        if (typeof chunk !== "string" || chunk.length === 0) {
          continue;
        }
        responseContent += chunk;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Stream error";
      responseContent = `Error: ${message}`;
    }
  } else {
    responseContent = conversation.channelId
      ? "该对话选择的渠道/模型不可用（可能已被禁用或已删除）。请在对话中重新选择模型。"
      : "未配置可用的默认渠道/默认模型。请先在设置中完成配置后再开始对话。";
  }

  const assistantMessageId = generateId();

  await db.insert(messages).values({
    id: assistantMessageId,
    conversationId: input.conversationId,
    role: "assistant",
    content: responseContent,
    model: responseModel,
    mode: input.mode || "chat",
    agentRun: null,
    liveMetadata: serializeLiveMetadata(liveContext),
    citations: serializeCitations(liveContext.citations),
    createdAt: new Date(),
  });

  return {
    userMessage: {
      id: userMessageId,
      role: "user",
      content: input.content,
      createdAt: now,
    },
    assistantMessage: {
      id: assistantMessageId,
      role: "assistant",
      content: responseContent,
      createdAt: new Date(),
    },
  };
}

export async function deleteMessage(userId: string, messageId: string) {
  const message = await db.select().from(messages).where(eq(messages.id, messageId)).limit(1);

  if (message.length === 0) {
    throw new Error("Message not found");
  }

  const conversation = await db
    .select()
    .from(conversations)
    .where(and(eq(conversations.id, message[0].conversationId), eq(conversations.userId, userId)))
    .limit(1);

  if (conversation.length === 0) {
    throw new Error("Conversation not found");
  }

  await db.delete(attachments).where(eq(attachments.messageId, messageId));
  await db.delete(messages).where(eq(messages.id, messageId));

  return { success: true };
}

export async function streamMessage(
  userId: string,
  input: StreamMessageInput,
): Promise<ReadableStream> {
  return createSseStream(async (send, ctx) => {
    const conversation = await getConversationForUser(userId, input.conversationId);
    const mode = input.mode === "chat" ? "chat" : "agent";

    const userMessageId = generateId();
    const now = new Date();
    await db.insert(messages).values({
      id: userMessageId,
      conversationId: input.conversationId,
      role: "user",
      content: input.content,
      mode,
      attachments: input.attachments ? JSON.stringify(input.attachments) : null,
      agentRun: null,
      createdAt: now,
    });

    if (input.attachments?.length) {
      await linkAttachmentsToMessage(input.attachments, userMessageId, userId);
    }

    const assistantMessageId = generateId();
    const assistantCreatedAt = new Date(now.getTime() + 1);

    await db
      .update(conversations)
      .set({
        updatedAt: now,
        lastMode: mode,
        runStatus: mode === "agent" ? "running" : null,
      })
      .where(eq(conversations.id, input.conversationId));

    if (mode === "agent") {
      await db.insert(messages).values({
        id: assistantMessageId,
        conversationId: input.conversationId,
        role: "assistant",
        content: "",
        model: conversation.modelId || null,
        mode: "agent",
        attachments: null,
        agentRun: null,
        liveMetadata: null,
        citations: null,
        createdAt: assistantCreatedAt,
      });

      const { agentRun, modelId } = await applyTaskBackedAgentTurnToMessage({
        userId,
        conversation,
        conversationId: input.conversationId,
        assistantMessageId,
        prompt: input.content,
        attachmentIds: input.attachments || [],
        agentOverrides: input.agentOverrides,
      });

      send({
        type: "done",
        messageId: assistantMessageId,
        model: modelId || undefined,
        agentRun,
      });
      return;
    }

    const resolvedChannel = await getResolvedChannelForConversation(userId, conversation);
    const settings = await getSettingValues(userId, [
      GLOBAL_SYSTEM_PROMPT_KEY,
      TAVILY_API_KEY_SETTING,
      TAVILY_ENABLED_SETTING,
    ]);
    const baseSystemPrompt =
      conversation.systemPrompt || settings[GLOBAL_SYSTEM_PROMPT_KEY] || null;
    const classifier = resolvedChannel
      ? (prompt: string) =>
          classifyLiveRouteWithModel({
            protocol: resolvedChannel.channel.protocol,
            apiKey: resolvedChannel.apiKey,
            baseUrl: resolvedChannel.channel.baseUrl,
            modelId: resolvedChannel.modelId,
            prompt,
          })
      : undefined;
    const liveContext = await buildLiveContext({
      prompt: input.content,
      userSettings: settings,
      tavilyEnvKey: process.env.TAVILY_API_KEY ?? null,
      forceWebSearch: Boolean(conversation.forceWebSearch),
      classifier,
    });
    const effectiveSystemPrompt = buildEffectiveSystemPrompt(baseSystemPrompt, liveContext);
    send(buildLiveStatusPayload(liveContext));
    const citationsPayload = buildCitationsPayload(liveContext.citations);
    if (citationsPayload) {
      send(citationsPayload);
    }

    const conversationMessages = await getMessages(input.conversationId);
    const chatMessages = await buildChatMessages(userId, conversationMessages, effectiveSystemPrompt);

    if (!resolvedChannel) {
      const message = conversation.channelId
        ? "该对话选择的渠道/模型不可用（可能已被禁用或已删除）。请在对话中重新选择模型。"
        : "未配置可用的默认渠道/默认模型。请先在设置中完成配置后再开始对话。";

      await db.insert(messages).values({
        id: assistantMessageId,
        conversationId: input.conversationId,
        role: "assistant",
        content: message,
        model: conversation.modelId || null,
        mode: "chat",
        attachments: null,
        agentRun: null,
        liveMetadata: serializeLiveMetadata(liveContext),
        citations: serializeCitations(liveContext.citations),
        createdAt: assistantCreatedAt,
      });

      await db
        .update(conversations)
        .set({
          updatedAt: new Date(),
          lastMode: "chat",
          runStatus: null,
        })
        .where(eq(conversations.id, input.conversationId));

      send({ type: "done", messageId: assistantMessageId });
      return;
    }

    await db.insert(messages).values({
      id: assistantMessageId,
      conversationId: input.conversationId,
      role: "assistant",
      content: "",
      model: resolvedChannel.modelId,
      mode: "chat",
      attachments: null,
      agentRun: null,
      liveMetadata: null,
      citations: null,
      createdAt: assistantCreatedAt,
    });

    const adapter = createAdapter(
      resolvedChannel.channel.protocol,
      resolvedChannel.apiKey,
      resolvedChannel.channel.baseUrl || undefined,
    );

    let responseContent = "";
    try {
      const stream = await adapter.chatStream({
        model: resolvedChannel.modelId,
        messages: chatMessages,
        maxTokens: 4096,
        signal: ctx.signal,
      });

      for await (const chunk of stream) {
        if (typeof chunk !== "string" || chunk.length === 0) {
          continue;
        }
        responseContent += chunk;
        send({ type: "delta", content: chunk });
      }
    } catch (error) {
      // A client disconnect aborts ctx.signal, which surfaces here as an abort
      // error. That is a normal cancellation, not a failure — keep whatever
      // partial content already streamed instead of overwriting it with an
      // "Error:" message that would be persisted as the assistant's reply.
      if (!ctx.signal.aborted) {
        const message = error instanceof Error ? error.message : "Stream error";
        responseContent = `Error: ${message}`;
      }
    }

    await db
      .update(messages)
      .set({
        content: responseContent,
        model: resolvedChannel.modelId,
        liveMetadata: serializeLiveMetadata(liveContext),
        citations: serializeCitations(liveContext.citations),
      })
      .where(eq(messages.id, assistantMessageId));

    await db
      .update(conversations)
      .set({
        updatedAt: new Date(),
        lastMode: "chat",
        runStatus: null,
      })
      .where(eq(conversations.id, input.conversationId));

    send({
      type: "done",
      messageId: assistantMessageId,
      model: resolvedChannel.modelId,
    });
  });
}

export async function editUserMessage(
  userId: string,
  userMessageId: string,
  newContent: string,
): Promise<ReadableStream> {
  return createSseStream(async (send, ctx) => {
    const [userMsg] = await db.select().from(messages).where(eq(messages.id, userMessageId));
    if (!userMsg || userMsg.role !== "user") {
      send({ type: "error", message: "Message not found" });
      return;
    }

    const conversation = await getConversationForUser(userId, userMsg.conversationId);

    const allMsgs = await getMessages(userMsg.conversationId);
    const idx = allMsgs.findIndex((m) => m.id === userMessageId);
    if (idx < 0) {
      send({ type: "error", message: "Message not found" });
      return;
    }

    const nextMsg = idx >= 0 ? allMsgs[idx + 1] : null;
    const shouldCreateAssistantReply = !nextMsg;
    if (nextMsg && nextMsg.role !== "assistant") {
      send({ type: "error", message: "找不到对应的 AI 回复消息" });
      return;
    }
    const assistantMessageId = nextMsg?.id ?? generateId();
    const assistantMode = (nextMsg?.mode ?? userMsg.mode) === "agent" ? "agent" : "chat";

    // Update the user message content
    await db
      .update(messages)
      .set({ content: newContent.trim() })
      .where(eq(messages.id, userMessageId));

    // Build context up to (not including) the assistant message, with updated user content
    const contextMsgs = allMsgs
      .slice(0, idx + 1)
      .map((m) => (m.id === userMessageId ? { ...m, content: newContent.trim() } : m));
    if (assistantMode === "agent") {
      const attachmentIds = parseJsonArray(userMsg.attachments);
      const contextPaths = parseJsonArray(userMsg.contextPaths);
      const workspaceId =
        nextMsg?.workspaceId || userMsg.workspaceId || conversation.workspaceId || null;

      if (shouldCreateAssistantReply) {
        await db.insert(messages).values({
          id: assistantMessageId,
          conversationId: userMsg.conversationId,
          role: "assistant",
          content: "",
          model: conversation.modelId || null,
          mode: "agent",
          attachments: null,
          agentRun: null,
          workspaceId,
          contextPaths: contextPaths.length > 0 ? JSON.stringify(contextPaths) : null,
          liveMetadata: null,
          citations: null,
          createdAt: new Date(),
        });
      }

      const { agentRun, modelId } = await applyTaskBackedAgentTurnToMessage({
        userId,
        conversation,
        conversationId: userMsg.conversationId,
        assistantMessageId,
        prompt: newContent.trim(),
        attachmentIds,
        workspaceId,
        contextPaths,
      });

      send({
        type: "done",
        messageId: assistantMessageId,
        model: modelId || undefined,
        agentRun,
      });
      return;
    }

    const resolvedChannel = await getResolvedChannelForConversation(userId, conversation);
    const settings = await getSettingValues(userId, [
      GLOBAL_SYSTEM_PROMPT_KEY,
      TAVILY_API_KEY_SETTING,
      TAVILY_ENABLED_SETTING,
    ]);
    const baseSystemPrompt =
      conversation.systemPrompt || settings[GLOBAL_SYSTEM_PROMPT_KEY] || null;
    const classifier = resolvedChannel
      ? (prompt: string) =>
          classifyLiveRouteWithModel({
            protocol: resolvedChannel.channel.protocol,
            apiKey: resolvedChannel.apiKey,
            baseUrl: resolvedChannel.channel.baseUrl,
            modelId: resolvedChannel.modelId,
            prompt,
          })
      : undefined;
    const liveContext = await buildLiveContext({
      prompt: newContent.trim(),
      userSettings: settings,
      tavilyEnvKey: process.env.TAVILY_API_KEY ?? null,
      forceWebSearch: Boolean(conversation.forceWebSearch),
      classifier,
    });
    const effectiveSystemPrompt = buildEffectiveSystemPrompt(baseSystemPrompt, liveContext);
    send(buildLiveStatusPayload(liveContext));
    const citationsPayload = buildCitationsPayload(liveContext.citations);
    if (citationsPayload) {
      send(citationsPayload);
    }

    const chatMessages = await buildChatMessages(userId, contextMsgs, effectiveSystemPrompt);

    if (!resolvedChannel) {
      send({ type: "error", message: "未配置可用的默认渠道/默认模型。" });
      return;
    }

    if (shouldCreateAssistantReply) {
      await db.insert(messages).values({
        id: assistantMessageId,
        conversationId: userMsg.conversationId,
        role: "assistant",
        content: "",
        model: resolvedChannel.modelId,
        mode: "chat",
        attachments: null,
        agentRun: null,
        liveMetadata: null,
        citations: null,
        createdAt: new Date(),
      });
    }

    const adapter = createAdapter(
      resolvedChannel.channel.protocol,
      resolvedChannel.apiKey,
      resolvedChannel.channel.baseUrl || undefined,
    );

    let responseContent = "";
    const stream = await adapter.chatStream({
      model: resolvedChannel.modelId,
      messages: chatMessages,
      maxTokens: 4096,
      signal: ctx.signal,
    });

    for await (const chunk of stream) {
      if (typeof chunk !== "string" || chunk.length === 0) continue;
      responseContent += chunk;
      send({ type: "delta", content: chunk });
    }

    await db
      .update(messages)
      .set({
        content: responseContent,
        model: resolvedChannel.modelId,
        liveMetadata: serializeLiveMetadata(liveContext),
        citations: serializeCitations(liveContext.citations),
      })
      .where(eq(messages.id, assistantMessageId));

    send({ type: "done", messageId: assistantMessageId, model: resolvedChannel.modelId });
  });
}

export async function regenerateMessage(
  userId: string,
  assistantMessageId: string,
  fallback?: {
    fallbackUserMessageId?: string;
    fallbackUserContent?: string;
  },
): Promise<ReadableStream> {
  const [prefetchedAssistantMsg] = await db
    .select()
    .from(messages)
    .where(eq(messages.id, assistantMessageId));

  if (
    (!prefetchedAssistantMsg || prefetchedAssistantMsg.role !== "assistant") &&
    fallback?.fallbackUserMessageId &&
    fallback.fallbackUserContent
  ) {
    return editUserMessage(userId, fallback.fallbackUserMessageId, fallback.fallbackUserContent);
  }

  return createSseStream(async (send, ctx) => {
    const assistantMsg =
      prefetchedAssistantMsg && prefetchedAssistantMsg.role === "assistant"
        ? prefetchedAssistantMsg
        : (await db.select().from(messages).where(eq(messages.id, assistantMessageId)))[0];
    if (!assistantMsg || assistantMsg.role !== "assistant") {
      send({ type: "error", message: "Message not found" });
      return;
    }

    const conversation = await getConversationForUser(userId, assistantMsg.conversationId);
    const assistantMode = assistantMsg.mode === "agent" ? "agent" : "chat";

    if (assistantMode === "agent") {
      const allMsgs = await getMessages(assistantMsg.conversationId);
      const idx = allMsgs.findIndex((m) => m.id === assistantMessageId);
      if (idx <= 0) {
        send({ type: "error", message: "找不到对应的用户消息" });
        return;
      }

      let userMsg: (typeof allMsgs)[number] | null = null;
      for (let i = idx - 1; i >= 0; i -= 1) {
        if (allMsgs[i]?.role === "user") {
          userMsg = allMsgs[i];
          break;
        }
      }

      if (!userMsg) {
        send({ type: "error", message: "找不到对应的用户消息" });
        return;
      }

      const attachmentIds = parseJsonArray(userMsg.attachments);
      const contextPaths = parseJsonArray(userMsg.contextPaths);
      const workspaceId =
        assistantMsg.workspaceId || userMsg.workspaceId || conversation.workspaceId || null;

      const { agentRun, modelId } = await applyTaskBackedAgentTurnToMessage({
        userId,
        conversation,
        conversationId: assistantMsg.conversationId,
        assistantMessageId,
        prompt: userMsg.content,
        attachmentIds,
        workspaceId,
        contextPaths,
      });

      send({
        type: "done",
        messageId: assistantMessageId,
        model: modelId || undefined,
        agentRun,
      });
      return;
    }

    const allMsgs = await getMessages(assistantMsg.conversationId);
    const idx = allMsgs.findIndex((m) => m.id === assistantMessageId);
    const contextMsgs = idx > 0 ? allMsgs.slice(0, idx) : allMsgs;
    const resolvedChannel = await getResolvedChannelForConversation(userId, conversation);
    const settings = await getSettingValues(userId, [
      GLOBAL_SYSTEM_PROMPT_KEY,
      TAVILY_API_KEY_SETTING,
      TAVILY_ENABLED_SETTING,
    ]);
    const baseSystemPrompt =
      conversation.systemPrompt || settings[GLOBAL_SYSTEM_PROMPT_KEY] || null;
    const lastUserMessage = [...contextMsgs].reverse().find((message) => message.role === "user");
    const classifier = resolvedChannel
      ? (prompt: string) =>
          classifyLiveRouteWithModel({
            protocol: resolvedChannel.channel.protocol,
            apiKey: resolvedChannel.apiKey,
            baseUrl: resolvedChannel.channel.baseUrl,
            modelId: resolvedChannel.modelId,
            prompt,
          })
      : undefined;
    const liveContext = await buildLiveContext({
      prompt: lastUserMessage?.content || "",
      userSettings: settings,
      tavilyEnvKey: process.env.TAVILY_API_KEY ?? null,
      forceWebSearch: Boolean(conversation.forceWebSearch),
      classifier,
    });
    const effectiveSystemPrompt = buildEffectiveSystemPrompt(baseSystemPrompt, liveContext);
    send(buildLiveStatusPayload(liveContext));
    const citationsPayload = buildCitationsPayload(liveContext.citations);
    if (citationsPayload) {
      send(citationsPayload);
    }
    const chatMessages = await buildChatMessages(userId, contextMsgs, effectiveSystemPrompt);

    if (!resolvedChannel) {
      send({ type: "error", message: "未配置可用的默认渠道/默认模型。" });
      return;
    }

    const adapter = createAdapter(
      resolvedChannel.channel.protocol,
      resolvedChannel.apiKey,
      resolvedChannel.channel.baseUrl || undefined,
    );

    let responseContent = "";
    const stream = await adapter.chatStream({
      model: resolvedChannel.modelId,
      messages: chatMessages,
      maxTokens: 4096,
      signal: ctx.signal,
    });

    for await (const chunk of stream) {
      if (typeof chunk !== "string" || chunk.length === 0) continue;
      responseContent += chunk;
      send({ type: "delta", content: chunk });
    }

    await db
      .update(messages)
      .set({
        content: responseContent,
        model: resolvedChannel.modelId,
        liveMetadata: serializeLiveMetadata(liveContext),
        citations: serializeCitations(liveContext.citations),
      })
      .where(eq(messages.id, assistantMessageId));

    send({ type: "done", messageId: assistantMessageId, model: resolvedChannel.modelId });
  });
}

// Sidecar (local) runs never upload attachment files to the server; only their
// metadata is synced so the user's bubble keeps its attachment chips across
// reloads. The rows reuse the attachments table with a `local:` filePath
// sentinel meaning "metadata only, no server-side file".
async function insertSidecarAttachmentMeta(
  conversationId: string,
  userMessageId: string,
  meta: Array<{ fileName: string; fileType?: string; fileSize?: number }>,
  createdAt: Date,
) {
  const rows = meta
    .filter((item) => typeof item?.fileName === "string" && item.fileName.length > 0)
    .map((item) => ({
      id: generateId(),
      conversationId,
      sessionId: null,
      messageId: userMessageId,
      fileName: item.fileName,
      filePath: `local:${item.fileName}`,
      fileType:
        typeof item.fileType === "string" && item.fileType.length > 0
          ? item.fileType
          : "application/octet-stream",
      fileSize:
        typeof item.fileSize === "number" && Number.isFinite(item.fileSize) ? item.fileSize : 0,
      createdAt,
    }));
  if (rows.length === 0) return;
  await db.insert(attachments).values(rows);
}

export async function syncSidecarMessages(
  userId: string,
  input: {
    conversationId: string;
    userContent: string;
    assistantContent: string;
    model?: string;
    mode?: string;
    agentRun?: unknown;
    // Metadata-only attachment info for local (sidecar) runs — see
    // insertSidecarAttachmentMeta. When provided on an in-place update, it
    // replaces the user message's existing attachment rows.
    attachmentsMeta?: Array<{ fileName: string; fileType?: string; fileSize?: number }>;
    // When both ids are provided and belong to this conversation, the existing
    // round is UPDATED in place (used by edit-and-resend) instead of inserting a
    // new pair — otherwise editing would duplicate the round on reload.
    userMessageId?: string;
    assistantMessageId?: string;
  },
) {
  const conversation = await db.query.conversations.findFirst({
    where: and(
      eq(conversations.id, input.conversationId),
      eq(conversations.userId, userId),
    ),
  });
  if (!conversation) throw new Error("Conversation not found");

  const now = new Date();

  if (input.userMessageId && input.assistantMessageId) {
    const [existingUser, existingAssistant] = await Promise.all([
      db.query.messages.findFirst({
        where: and(
          eq(messages.id, input.userMessageId),
          eq(messages.conversationId, input.conversationId),
        ),
      }),
      db.query.messages.findFirst({
        where: and(
          eq(messages.id, input.assistantMessageId),
          eq(messages.conversationId, input.conversationId),
        ),
      }),
    ]);
    if (existingUser && existingAssistant) {
      await db
        .update(messages)
        .set({ content: input.userContent })
        .where(eq(messages.id, input.userMessageId));
      await db
        .update(messages)
        .set({
          content: input.assistantContent,
          model: input.model || null,
          agentRun: input.agentRun ? JSON.stringify(input.agentRun) : null,
          liveMetadata: null,
          citations: null,
        })
        .where(eq(messages.id, input.assistantMessageId));
      if (Array.isArray(input.attachmentsMeta)) {
        // Replace, not append: the edit's meta is authoritative for this message.
        await db.delete(attachments).where(eq(attachments.messageId, input.userMessageId));
        await insertSidecarAttachmentMeta(
          input.conversationId,
          input.userMessageId,
          input.attachmentsMeta,
          now,
        );
      }
      return {
        userMessageId: input.userMessageId,
        assistantMessageId: input.assistantMessageId,
      };
    }
  }

  const userMessageId = generateId();
  const assistantMessageId = generateId();

  await db.insert(messages).values({
    id: userMessageId,
    conversationId: input.conversationId,
    role: "user",
    content: input.userContent,
    mode: input.mode || "agent",
    attachments: null,
    agentRun: null,
    createdAt: now,
  });

  if (Array.isArray(input.attachmentsMeta) && input.attachmentsMeta.length > 0) {
    await insertSidecarAttachmentMeta(
      input.conversationId,
      userMessageId,
      input.attachmentsMeta,
      now,
    );
  }

  await db.insert(messages).values({
    id: assistantMessageId,
    conversationId: input.conversationId,
    role: "assistant",
    content: input.assistantContent,
    model: input.model || null,
    mode: input.mode || "agent",
    attachments: null,
    agentRun: input.agentRun ? JSON.stringify(input.agentRun) : null,
    liveMetadata: null,
    citations: null,
    createdAt: new Date(now.getTime() + 1),
  });

  return { userMessageId, assistantMessageId };
}

export interface PrepareChatInput {
  conversationId: string;
  content: string;
  attachments?: string[];
}

export interface PrepareChatResult {
  apiKey: string;
  baseUrl: string | null;
  protocol: string;
  model: string;
  messages: ChatMessage[];
  userMessageId: string;
  assistantMessageId: string;
}

export async function prepareChatForSidecar(
  userId: string,
  input: PrepareChatInput,
): Promise<PrepareChatResult> {
  const conversation = await getConversationForUser(userId, input.conversationId);

  const now = new Date();
  const userMessageId = generateId();
  await db.insert(messages).values({
    id: userMessageId,
    conversationId: input.conversationId,
    role: "user",
    content: input.content,
    mode: "chat",
    attachments: input.attachments ? JSON.stringify(input.attachments) : null,
    agentRun: null,
    createdAt: now,
  });

  if (input.attachments?.length) {
    await linkAttachmentsToMessage(input.attachments, userMessageId, userId);
  }

  const assistantMessageId = generateId();
  const assistantCreatedAt = new Date(now.getTime() + 1);

  await db
    .update(conversations)
    .set({ updatedAt: now, lastMode: "chat", runStatus: null })
    .where(eq(conversations.id, input.conversationId));

  const resolvedChannel = await getResolvedChannelForConversation(userId, conversation);
  if (!resolvedChannel) {
    const message = conversation.channelId
      ? "该对话选择的渠道/模型不可用（可能已被禁用或已删除）。请在对话中重新选择模型。"
      : "未配置可用的默认渠道/默认模型。请先在设置中完成配置后再开始对话。";
    throw new Error(message);
  }

  await db.insert(messages).values({
    id: assistantMessageId,
    conversationId: input.conversationId,
    role: "assistant",
    content: "",
    model: resolvedChannel.modelId,
    mode: "chat",
    attachments: null,
    agentRun: null,
    liveMetadata: null,
    citations: null,
    createdAt: assistantCreatedAt,
  });

  const settings = await getSettingValues(userId, [GLOBAL_SYSTEM_PROMPT_KEY]);
  const baseSystemPrompt =
    conversation.systemPrompt || settings[GLOBAL_SYSTEM_PROMPT_KEY] || null;

  const conversationMessages = await getMessages(input.conversationId);
  const chatMessages = await buildChatMessages(userId, conversationMessages, baseSystemPrompt);

  return {
    apiKey: resolvedChannel.apiKey,
    baseUrl: resolvedChannel.channel.baseUrl || null,
    protocol: resolvedChannel.channel.protocol,
    model: resolvedChannel.modelId,
    messages: chatMessages,
    userMessageId,
    assistantMessageId,
  };
}

export interface CompleteChatInput {
  assistantMessageId: string;
  conversationId: string;
  content: string;
  model?: string;
}

export async function completeChatFromSidecar(
  userId: string,
  input: CompleteChatInput,
): Promise<void> {
  const conversation = await getConversationForUser(userId, input.conversationId);

  await db
    .update(messages)
    .set({
      content: input.content,
      model: input.model || null,
    })
    .where(eq(messages.id, input.assistantMessageId));

  await db
    .update(conversations)
    .set({ updatedAt: new Date(), lastMode: "chat", runStatus: null })
    .where(eq(conversations.id, conversation.id));
}
