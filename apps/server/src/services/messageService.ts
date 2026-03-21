import { attachments, conversations, messages } from "db";
import { and, asc, eq, inArray } from "drizzle-orm";
import { type ChatContentPart, type ChatMessage, createAdapter } from "../agent-adapters";
import { db } from "../db";
import { generateId } from "../utils";
import { createSseStream } from "../utils/sse";
import { type AgentRuntimeConfig, runAgentWithConfig } from "./agentService";
import {
  type AgentTaskComplexity,
  type AgentTaskUxMode,
  createAgentApprovalRequest,
  createAgentRun,
  createAgentTask,
  createAgentTaskEvent,
  getAgentTaskDetail,
  respondToAgentApproval,
  setAgentPlanSteps,
  updateAgentRunStatus,
  updateAgentTaskStatus,
} from "./agentTaskService";
import { buildAttachmentPayloadFromIds, linkAttachmentsToMessage } from "./attachmentService";
import { getResolvedChannelForConversation } from "./channelService";
import { buildLiveContext, type LiveContextResult, toStoredLiveMetadata } from "./liveCapabilities";
import { classifyLiveRouteWithModel } from "./liveRouteClassifier";
import {
  type SearchCitation,
  TAVILY_API_KEY_SETTING,
  TAVILY_ENABLED_SETTING,
} from "./searchService";
import { getSettingValues } from "./settingsService";

const GLOBAL_SYSTEM_PROMPT_KEY = "chat.systemPrompt";
const AGENT_RECENT_CONTEXT_LIMIT = 8;

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
  taskId?: string;
  complexity?: AgentTaskComplexity;
  uxMode?: AgentTaskUxMode;
  requiresPlanApproval?: boolean;
  autoStart?: boolean;
  taskStatus?: "draft" | "planning" | "awaiting_approval" | "running" | "completed" | "failed" | "cancelled";
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

function classifyChatAgentComplexity(params: {
  goal: string;
  attachmentCount: number;
}): {
  complexity: AgentTaskComplexity;
  uxMode: AgentTaskUxMode;
  requiresPlanApproval: boolean;
  autoStart: boolean;
} {
  const normalized = params.goal.trim().toLowerCase();
  const hasAttachments = params.attachmentCount > 0;
  const deepSignals = [
    /调研/,
    /研究/,
    /竞品/,
    /报告/,
    /方案/,
    /完整/,
    /全面/,
    /多步骤/,
    /多阶段/,
    /持续/,
    /对比.+对比/,
    /compare/i,
    /analysis/i,
    /research/i,
    /report/i,
  ];
  const deepStructureSignals = [
    /需要包含/,
    /包括/,
    /边界/,
    /风险/,
    /验证/,
    /恢复/,
    /审批/,
    /流程/,
    /步骤/,
    /多维/,
  ];
  const standardSignals = [
    /对比/,
    /比较/,
    /汇总/,
    /整理/,
    /提取/,
    /总结/,
    /多个/,
    /几家/,
    /最近/,
    /网页/,
    /链接/,
    /资讯/,
    /新闻/,
  ];
  const deepSignalCount = deepSignals.filter((pattern) => pattern.test(normalized)).length;
  const deepStructureCount = deepStructureSignals.filter((pattern) => pattern.test(normalized)).length;
  const isDeep =
    deepSignalCount > 0 ||
    (normalized.length >= 120 && deepStructureCount >= 2) ||
    (hasAttachments && normalized.length >= 80 && deepStructureCount >= 1);

  if (isDeep) {
    return {
      complexity: "deep",
      uxMode: "full",
      requiresPlanApproval: false,
      autoStart: true,
    };
  }

  const isStandard =
    hasAttachments ||
    normalized.length >= 36 ||
    standardSignals.some((pattern) => pattern.test(normalized));

  if (isStandard) {
    return {
      complexity: "standard",
      uxMode: "compact",
      requiresPlanApproval: false,
      autoStart: true,
    };
  }

  return {
    complexity: "light",
    uxMode: "direct",
    requiresPlanApproval: false,
    autoStart: true,
  };
}

function buildTaskPlanFromGoal(goal: string, complexity: AgentTaskComplexity) {
  const normalized = goal.trim().replace(/\s+/g, " ");
  const executionTitle =
    normalized.length > 72 ? `${normalized.slice(0, 69).trim()}...` : normalized;

  if (complexity === "light") {
    return [
      {
        title: "获取所需信息",
        description: "只查询完成当前请求所需的最少信息。",
        status: "ready" as const,
      },
      {
        title: executionTitle || "直接给出结果",
        description: "整理结论并直接返回可用答案。",
        status: "pending" as const,
      },
    ];
  }

  if (complexity === "standard") {
    return [
      {
        title: "收集关键信息",
        description: "先抓取完成任务所需的关键资料或来源。",
        status: "ready" as const,
      },
      {
        title: executionTitle || "整理主要内容",
        description: "提炼重点并形成一版结构化结果。",
        status: "pending" as const,
      },
      {
        title: "输出简洁结论",
        description: "把结果压缩成用户可以直接使用的结论。",
        status: "pending" as const,
      },
    ];
  }

  return [
    {
      title: "明确任务范围与约束",
      description: "先确认目标、附件和边界条件，避免执行偏题。",
      status: "ready" as const,
    },
    {
      title: executionTitle || "执行任务",
      description: "按照计划推进核心处理流程，并按需调用工具。",
      status: "pending" as const,
    },
    {
      title: "核验结果并整理交付",
      description: "校验结果质量、补充风险说明并生成最终交付。",
      status: "pending" as const,
    },
  ];
}

function buildTaskBackedAgentSummary(
  taskStatus: AgentRunData["taskStatus"],
  uxMode: AgentTaskUxMode,
) {
  if (uxMode === "direct") {
    switch (taskStatus) {
      case "planning":
        return "正在准备后直接处理这项任务。";
      case "running":
        return "正在直接处理这项任务。";
      case "completed":
        return "任务已完成。";
      case "failed":
        return "任务处理失败，可以重试。";
      case "cancelled":
        return "任务已取消。";
      default:
        return "我先直接处理这项任务。";
    }
  }

  if (uxMode === "compact") {
    switch (taskStatus) {
      case "planning":
        return "正在整理简要步骤并开始执行。";
      case "running":
        return "正在按简要步骤处理这项任务。";
      case "completed":
        return "任务已完成。";
      case "failed":
        return "任务处理失败，可以重试或查看过程。";
      case "cancelled":
        return "任务已取消。";
      default:
        return "我会按简要步骤直接开始处理。";
    }
  }

  switch (taskStatus) {
    case "planning":
      return "正在整理执行路径并开始执行。";
    case "awaiting_approval":
      return "任务暂时停下，等待进一步批准。";
    case "running":
      return "任务正在执行。";
    case "completed":
      return "任务已完成。";
    case "failed":
      return "任务执行失败，可继续、重试或重新规划。";
    case "cancelled":
      return "任务已取消。";
    default:
      return "我会先展开任务并开始执行。";
  }
}

function buildTaskBackedAgentContent(detail: Awaited<ReturnType<typeof getAgentTaskDetail>>) {
  const finalResult =
    detail.artifacts.find((artifact) => artifact.type === "final_result")?.content.trim() ?? "";
  const statusSummary = buildTaskBackedAgentSummary(detail.task.status, detail.task.uxMode);
  if (detail.task.status === "completed" && finalResult) {
    return finalResult;
  }

  const preview = detail.task.insight?.previewText?.trim() || "";
  const completedSummary = detail.task.insight?.summary?.trim() || "";
  if (detail.task.status === "completed") {
    return preview || completedSummary || statusSummary;
  }

  return preview || statusSummary;
}

function buildTaskBackedAgentRun(detail: Awaited<ReturnType<typeof getAgentTaskDetail>>): AgentRunData {
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
    summary: buildTaskBackedAgentSummary(detail.task.status, detail.task.uxMode),
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

async function createChatAgentTaskForConversation(params: {
  userId: string;
  conversationId: string;
  channelId: string | null;
  modelId: string | null;
  goal: string;
  attachmentIds: string[];
}) {
  const routing = classifyChatAgentComplexity({
    goal: params.goal,
    attachmentCount: params.attachmentIds.length,
  });
  const task = await createAgentTask(params.userId, {
    conversationId: params.conversationId,
    channelId: params.channelId,
    modelId: params.modelId,
    goal: params.goal,
    attachments: params.attachmentIds.map((id) => ({
      id,
      fileName: "attachment",
    })),
    complexity: routing.complexity,
    uxMode: routing.uxMode,
    requiresPlanApproval: routing.requiresPlanApproval,
    autoStart: routing.autoStart,
  });

  await updateAgentTaskStatus(params.userId, task.id, "planning");
  const run = await createAgentRun(params.userId, task.id, {
    phase: "planning",
    status: "running",
    startedAt: new Date(),
  });
  await createAgentTaskEvent(params.userId, task.id, run.id, {
    type: "task_status",
    content: "Task entered planning.",
    metadata: { status: "planning", source: "chat" },
  });

  const planSteps = await setAgentPlanSteps(params.userId, task.id, run.id, {
    steps: buildTaskPlanFromGoal(params.goal, routing.complexity),
  });

  for (const step of planSteps) {
    await createAgentTaskEvent(params.userId, task.id, run.id, {
      type: "plan_step",
      content: step.title,
      metadata: {
        orderIndex: step.orderIndex,
        description: step.description,
        status: step.status,
      },
    });
  }

  const approval = await createAgentApprovalRequest(params.userId, task.id, run.id, {
    type: "plan_approval",
    title: routing.requiresPlanApproval ? "Approve task execution" : "Task execution auto-approved",
    description: routing.requiresPlanApproval
      ? "Review the generated plan before the agent starts executing it."
      : "This task was auto-approved because it is simple enough to start immediately.",
    payload: {
      planStepIds: planSteps.map((step) => step.id),
      planStepCount: planSteps.length,
      autoApproved: !routing.requiresPlanApproval,
    },
  });

  if (routing.requiresPlanApproval) {
    await createAgentTaskEvent(params.userId, task.id, run.id, {
      type: "approval_requested",
      content: approval.title,
      metadata: { approvalId: approval.id, approvalType: approval.type, source: "chat" },
    });

    await updateAgentRunStatus(params.userId, run.id, "awaiting_approval");
    await updateAgentTaskStatus(params.userId, task.id, "awaiting_approval");
    await createAgentTaskEvent(params.userId, task.id, run.id, {
      type: "task_status",
      content: "Task is awaiting approval.",
      metadata: { status: "awaiting_approval", source: "chat" },
    });
  } else {
    const resolvedApproval = await respondToAgentApproval(params.userId, approval.id, {
      status: "approved",
      response: { source: "chat_auto_approved" },
    });
    await createAgentTaskEvent(params.userId, task.id, run.id, {
      type: "approval_resolved",
      content: resolvedApproval.title,
      metadata: {
        approvalId: resolvedApproval.id,
        approvalType: resolvedApproval.type,
        status: resolvedApproval.status,
        source: "chat",
      },
    });
    await updateAgentRunStatus(params.userId, run.id, "completed", {
      summary: "Planning completed and execution is ready to start.",
      completedAt: new Date(),
    });
    await updateAgentTaskStatus(params.userId, task.id, "draft");
    await createAgentTaskEvent(params.userId, task.id, run.id, {
      type: "task_status",
      content: "Task is ready to execute.",
      metadata: { status: "draft", autoStart: routing.autoStart, source: "chat" },
    });
  }

  return getAgentTaskDetail(params.userId, task.id);
}

function buildEffectiveSystemPrompt(
  systemPrompt: string | null | undefined,
  liveContext: LiveContextResult,
) {
  return (
    [systemPrompt, liveContext.systemContext]
      .map((value) => value?.trim())
      .filter((value): value is string => Boolean(value))
      .join("\n\n") || null
  );
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

  for await (const event of runAgentWithConfig(config)) {
    if (event.type === "text") {
      const chunk = event.content || "";
      if (!chunk) continue;
      responseContent += chunk;
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

  const agentRun: AgentRunData = {
    status: agentError ? "failed" : "completed",
    summary: buildAgentRunSummary(steps, agentError),
    error: agentError,
    steps,
  };

  return { responseContent, agentRun };
}

async function buildUserContentWithAttachments(content: string, attachmentIds?: string[]) {
  if (!attachmentIds || attachmentIds.length === 0) {
    return content;
  }

  const payload = await buildAttachmentPayloadFromIds(attachmentIds);
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

      const content = await buildUserContentWithAttachments(message.content, attachmentIds);
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
  const result = await getMessages(conversationId);

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
    await linkAttachmentsToMessage(input.attachments, userMessageId);
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
          provider: resolvedChannel.channel.provider,
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
    conversationMessages,
    buildEffectiveSystemPrompt(conversation.systemPrompt, liveContext),
  );

  let responseContent = "";
  let responseModel: string | null = null;

  if (resolvedChannel) {
    const adapter = createAdapter(
      resolvedChannel.channel.provider,
      resolvedChannel.apiKey,
      resolvedChannel.channel.baseUrl || undefined,
    );

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
    responseModel = resolvedChannel.modelId;
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

  await db.delete(messages).where(eq(messages.id, messageId));

  return { success: true };
}

export async function streamMessage(
  userId: string,
  input: StreamMessageInput,
): Promise<ReadableStream> {
  return createSseStream(async (send, _ctx) => {
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
      await linkAttachmentsToMessage(input.attachments, userMessageId);
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

      const detail = await createChatAgentTaskForConversation({
        userId,
        conversationId: input.conversationId,
        channelId: conversation.channelId || null,
        modelId: conversation.modelId || null,
        goal: input.content,
        attachmentIds: input.attachments || [],
      });
      const assistantContent = buildTaskBackedAgentContent(detail);
      const agentRun = buildTaskBackedAgentRun(detail);
      send({ type: "delta", content: assistantContent });

      await db
        .update(messages)
        .set({
          content: assistantContent,
          model: conversation.modelId || null,
          mode: "agent",
          agentRun: JSON.stringify(agentRun),
          liveMetadata: null,
          citations: null,
        })
        .where(eq(messages.id, assistantMessageId));

      await db
        .update(conversations)
        .set({
          updatedAt: new Date(),
          lastMode: "agent",
          runStatus: detail.task.status,
        })
        .where(eq(conversations.id, input.conversationId));

      send({
        type: "done",
        messageId: assistantMessageId,
        model: conversation.modelId || undefined,
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
            provider: resolvedChannel.channel.provider,
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
    const chatMessages = await buildChatMessages(conversationMessages, effectiveSystemPrompt);

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
      resolvedChannel.channel.provider,
      resolvedChannel.apiKey,
      resolvedChannel.channel.baseUrl || undefined,
    );

    let responseContent = "";
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
        send({ type: "delta", content: chunk });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Stream error";
      responseContent = `Error: ${message}`;
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
  return createSseStream(async (send, _ctx) => {
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

      await db
        .update(conversations)
        .set({
          updatedAt: new Date(),
          workspaceId,
          lastMode: "agent",
          runStatus: "running",
        })
        .where(eq(conversations.id, userMsg.conversationId));

      const detail = await createChatAgentTaskForConversation({
        userId,
        conversationId: userMsg.conversationId,
        channelId: conversation.channelId || null,
        modelId: conversation.modelId || null,
        goal: newContent.trim(),
        attachmentIds,
      });
      const responseContent = buildTaskBackedAgentContent(detail);
      const agentRun = buildTaskBackedAgentRun(detail);
      send({ type: "delta", content: responseContent });

      await db
        .update(messages)
        .set({
          content: responseContent,
          model: conversation.modelId || null,
          mode: "agent",
          workspaceId,
          contextPaths: contextPaths.length > 0 ? JSON.stringify(contextPaths) : null,
          agentRun: JSON.stringify(agentRun),
          liveMetadata: null,
          citations: null,
        })
        .where(eq(messages.id, assistantMessageId));

      await db
        .update(conversations)
        .set({
          updatedAt: new Date(),
          workspaceId,
          lastMode: "agent",
          runStatus: detail.task.status,
        })
        .where(eq(conversations.id, userMsg.conversationId));

      send({
        type: "done",
        messageId: assistantMessageId,
        model: conversation.modelId || undefined,
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
            provider: resolvedChannel.channel.provider,
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

    const chatMessages = await buildChatMessages(contextMsgs, effectiveSystemPrompt);

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
      resolvedChannel.channel.provider,
      resolvedChannel.apiKey,
      resolvedChannel.channel.baseUrl || undefined,
    );

    let responseContent = "";
    const stream = await adapter.chatStream({
      model: resolvedChannel.modelId,
      messages: chatMessages,
      maxTokens: 4096,
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

  return createSseStream(async (send, _ctx) => {
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

      await db
        .update(conversations)
        .set({
          updatedAt: new Date(),
          workspaceId,
          lastMode: "agent",
          runStatus: "running",
        })
        .where(eq(conversations.id, assistantMsg.conversationId));

      const detail = await createChatAgentTaskForConversation({
        userId,
        conversationId: assistantMsg.conversationId,
        channelId: conversation.channelId || null,
        modelId: conversation.modelId || null,
        goal: userMsg.content,
        attachmentIds,
      });
      const responseContent = buildTaskBackedAgentContent(detail);
      const agentRun = buildTaskBackedAgentRun(detail);
      send({ type: "delta", content: responseContent });

      await db
        .update(messages)
        .set({
          content: responseContent,
          model: conversation.modelId || null,
          mode: "agent",
          workspaceId,
          contextPaths: contextPaths.length > 0 ? JSON.stringify(contextPaths) : null,
          agentRun: JSON.stringify(agentRun),
          liveMetadata: null,
          citations: null,
        })
        .where(eq(messages.id, assistantMessageId));

      await db
        .update(conversations)
        .set({
          updatedAt: new Date(),
          workspaceId,
          lastMode: "agent",
          runStatus: detail.task.status,
        })
        .where(eq(conversations.id, assistantMsg.conversationId));

      send({
        type: "done",
        messageId: assistantMessageId,
        model: conversation.modelId || undefined,
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
            provider: resolvedChannel.channel.provider,
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
    const chatMessages = await buildChatMessages(contextMsgs, effectiveSystemPrompt);

    if (!resolvedChannel) {
      send({ type: "error", message: "未配置可用的默认渠道/默认模型。" });
      return;
    }

    const adapter = createAdapter(
      resolvedChannel.channel.provider,
      resolvedChannel.apiKey,
      resolvedChannel.channel.baseUrl || undefined,
    );

    let responseContent = "";
    const stream = await adapter.chatStream({
      model: resolvedChannel.modelId,
      messages: chatMessages,
      maxTokens: 4096,
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
