import { attachments, conversations, messages } from "db";
import { and, asc, eq, inArray } from "drizzle-orm";
import { type ChatContentPart, type ChatMessage, createAdapter } from "../agent-adapters";
import { client, db } from "../db";
import { generateId } from "../utils";
import { createSseStream } from "../utils/sse";
import { buildAgentPlan } from "./agentPlanBuilder";
import { buildTaskMessageSummary } from "./agentTaskMessage";
import type {
  AgentTaskComplexity,
  AgentTaskDetail,
  AgentTaskRecord,
  AgentTaskUxMode,
} from "./agentTaskService";
import {
  buildAttachmentPayloadFromIds,
  LOCAL_ATTACHMENT_PATH_PREFIX,
  linkAttachmentsToMessage,
  removeAttachmentFiles,
} from "./attachmentService";
import { getResolvedChannelForConversation } from "./channelService";
import { isChannelAvailable, recordChannelFailure, recordChannelSuccess } from "./circuitBreaker";
import { buildLiveContext, type LiveContextResult, toStoredLiveMetadata } from "./liveCapabilities";
import { classifyLiveRouteWithModel } from "./liveRouteClassifier";
import { classifyProviderError } from "./providerErrorSummary";
import { mergeSystemPromptParts, RESPONSE_STYLE_GUARDRAILS } from "./responseStyle";
import {
  type SearchCitation,
  TAVILY_API_KEY_SETTING,
  TAVILY_ENABLED_SETTING,
} from "./searchService";
import { getSettingValues } from "./settingsService";
import { getRecentSummaries, maybeSummarize } from "./summaryService";

const GLOBAL_SYSTEM_PROMPT_KEY = "chat.systemPrompt";
// Hard safety backstop for chat-mode model context. `getMessages` intentionally
// stays unbounded (it also feeds the UI message list), and the per-conversation
// `contextLength` column is a token budget (default 4096), not a message count —
// so it is not a clean message-count bound. This cap only trims pathologically
// long conversations; normal conversations stay well under it and are unchanged.
const CHAT_MAX_CONTEXT_MESSAGES = 200;
const CHAT_MAX_CONTEXT_TOKENS = 32_000;

function estimateChatTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

// ---------------------------------------------------------------------------
// FTS5 sync helpers — best-effort; the virtual table may not exist in test
// environments that skip bootstrapDatabase().
// ---------------------------------------------------------------------------

async function ftsUpsert(
  messageId: string,
  conversationId: string,
  content: string,
): Promise<void> {
  if (!content) return;
  try {
    const truncated = content.substring(0, 5000);
    await client.execute({
      sql: `DELETE FROM messages_fts WHERE message_id = ?`,
      args: [messageId],
    });
    await client.execute({
      sql: `INSERT INTO messages_fts(message_id, conversation_id, content) VALUES (?, ?, ?)`,
      args: [messageId, conversationId, truncated],
    });
  } catch {
    // FTS table may not exist yet (tests, pre-migration DBs)
  }
}

async function ftsDeleteMessage(messageId: string): Promise<void> {
  try {
    await client.execute({
      sql: `DELETE FROM messages_fts WHERE message_id = ?`,
      args: [messageId],
    });
  } catch {
    // best-effort
  }
}

export async function ftsDeleteConversation(conversationId: string): Promise<void> {
  try {
    await client.execute({
      sql: `DELETE FROM messages_fts WHERE conversation_id = ?`,
      args: [conversationId],
    });
  } catch {
    // best-effort
  }
}

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

/**
 * True once a task can no longer change. Used to skip pointless re-syncs on the
 * read path — see getMessagesForUserWithAttachments.
 *
 * A message whose stored agentRun has no taskStatus predates this field (or was
 * never synced), so it is deliberately treated as non-terminal and still synced.
 */
export function isTerminalTaskStatus(status: AgentRunData["taskStatus"]): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function getTaskFinalResultCitations(detail: AgentTaskDetail) {
  const finalResult = detail.artifacts.find((artifact) => artifact.type === "final_result") ?? null;
  if (
    !finalResult?.metadata ||
    typeof finalResult.metadata !== "object" ||
    Array.isArray(finalResult.metadata)
  ) {
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
      content: messages.content,
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

  const targets = candidateMessages.filter(
    (message) => parseAgentRunData(message.agentRun)?.taskId === taskId,
  );

  if (targets.length === 0) return;

  const nextContent = buildTaskMessageSummary(detail);
  const nextAgentRun = JSON.stringify(buildTaskBackedAgentRun(detail));

  // Skip the write when nothing actually changed. This runs on a read path, so
  // an unconditional UPDATE turns every message fetch into a write — and bumps
  // rows that no client will render any differently.
  const staleTargets = targets.filter(
    (message) => message.content !== nextContent || message.agentRun !== nextAgentRun,
  );
  if (staleTargets.length === 0) return;

  await db
    .update(messages)
    .set({
      content: nextContent,
      agentRun: nextAgentRun,
      citations: (() => {
        const citations = getTaskFinalResultCitations(detail);
        return citations && citations.length > 0 ? JSON.stringify(citations) : null;
      })(),
      liveMetadata: null,
    })
    .where(
      inArray(
        messages.id,
        staleTargets.map((message) => message.id),
      ),
    );

  // Sync FTS for each updated message
  await Promise.all(
    staleTargets.map((target) => ftsUpsert(target.id, conversationId, nextContent)),
  );
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
      updatedAt: new Date(),
    })
    .where(eq(messages.id, params.assistantMessageId));

  await ftsUpsert(params.assistantMessageId, params.conversationId, content);

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
  conversationId?: string | null,
): Promise<ChatMessage[]> {
  const chatMessages: ChatMessage[] = [];

  let effectiveSystemPrompt = systemPrompt || "";

  // For new conversations (< 3 messages), inject historical summaries as memory
  if (conversationId && conversationMessages.length < 3) {
    try {
      const summaries = await getRecentSummaries(userId, conversationId);
      if (summaries.length > 0) {
        const memoryBlock = summaries
          .map((s) => `### ${s.title || "未命名会话"}\n${s.summary}`)
          .join("\n\n");
        const memoryPrompt = `\n\n## 历史对话记忆\n以下是用户近期对话的摘要，可供参考（不必主动提及，仅在相关时引用）：\n\n${memoryBlock}`;
        effectiveSystemPrompt = effectiveSystemPrompt
          ? effectiveSystemPrompt + memoryPrompt
          : memoryPrompt.trim();
      }
    } catch {
      // Best-effort: do not block the conversation
    }
  }

  if (effectiveSystemPrompt) {
    appendChatMessage(chatMessages, "system", effectiveSystemPrompt);
  }

  // Two-stage truncation: first a message-count cap, then a token-budget cap.
  // The message-count cap is a coarse backstop; the token cap is the real limit.
  let boundedMessages =
    conversationMessages.length > CHAT_MAX_CONTEXT_MESSAGES
      ? conversationMessages.slice(-CHAT_MAX_CONTEXT_MESSAGES)
      : conversationMessages;

  let tokenBudget = CHAT_MAX_CONTEXT_TOKENS;
  if (systemPrompt) tokenBudget -= estimateChatTokens(systemPrompt);
  let totalTokens = 0;
  let startIdx = boundedMessages.length;
  for (let i = boundedMessages.length - 1; i >= 0; i--) {
    const tokens = estimateChatTokens(boundedMessages[i]!.content) + 10;
    if (totalTokens + tokens > tokenBudget) break;
    totalTokens += tokens;
    startIdx = i;
  }
  if (startIdx > 0) {
    boundedMessages = boundedMessages.slice(startIdx);
  }

  for (const message of boundedMessages) {
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

  // Only tasks that might still change are worth re-syncing. A task that has
  // already been recorded as completed/failed/cancelled can never produce a
  // different summary, so re-reading it on every message fetch costs 8 queries
  // (6 for the detail, 1 scan, 1 write) and changes nothing. A conversation of
  // 20 finished agent turns used to spend ~160 queries — plus a write — every
  // time it was opened.
  const taskIds = Array.from(
    new Set(
      result
        .filter((message) => message.role === "assistant" && message.mode === "agent")
        .map((message) => parseAgentRunData(message.agentRun))
        .filter((run): run is AgentRunData => run !== null)
        .filter((run) => !isTerminalTaskStatus(run.taskStatus))
        .map((run) => run.taskId)
        .filter(
          (taskId): taskId is string => typeof taskId === "string" && taskId.trim().length > 0,
        ),
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
  await ftsUpsert(userMessageId, input.conversationId, input.content);

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
    input.conversationId,
  );

  let responseContent = "";
  let responseModel: string | null = null;

  if (resolvedChannel) {
    const channelId = resolvedChannel.channel.id;
    if (!isChannelAvailable(channelId)) {
      responseContent =
        "该渠道暂时不可用（连续多次请求失败，已触发熔断保护）。请稍后重试或切换其他渠道。";
    } else {
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
        recordChannelSuccess(channelId);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Stream error";
        responseContent = `Error: ${message}`;
        const classified = classifyProviderError(message);
        if (classified.retryable) {
          recordChannelFailure(channelId);
        }
      }
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
  await ftsUpsert(assistantMessageId, input.conversationId, responseContent);

  // Fire-and-forget: generate summary if the conversation is long enough
  void maybeSummarize(userId, input.conversationId).catch(() => {});

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

  // Read the blob paths before the rows go away; unlink only after commit.
  const attachmentFileRows = await db
    .select({ filePath: attachments.filePath })
    .from(attachments)
    .where(eq(attachments.messageId, messageId));

  await db.transaction(async (tx) => {
    await tx.delete(attachments).where(eq(attachments.messageId, messageId));
    await tx.delete(messages).where(eq(messages.id, messageId));
  });

  await ftsDeleteMessage(messageId);
  await removeAttachmentFiles(attachmentFileRows.map((row) => row.filePath).filter(Boolean));

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
    await ftsUpsert(userMessageId, input.conversationId, input.content);

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

      // Fire-and-forget: generate summary if the conversation is long enough
      void maybeSummarize(userId, input.conversationId).catch(() => {});

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
    const chatMessages = await buildChatMessages(
      userId,
      conversationMessages,
      effectiveSystemPrompt,
      input.conversationId,
    );

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
      await ftsUpsert(assistantMessageId, input.conversationId, message);

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

    const streamChannelId = resolvedChannel.channel.id;
    if (!isChannelAvailable(streamChannelId)) {
      const circuitMessage =
        "该渠道暂时不可用（连续多次请求失败，已触发熔断保护）。请稍后重试或切换其他渠道。";

      await db.insert(messages).values({
        id: assistantMessageId,
        conversationId: input.conversationId,
        role: "assistant",
        content: circuitMessage,
        model: resolvedChannel.modelId,
        mode: "chat",
        attachments: null,
        agentRun: null,
        liveMetadata: serializeLiveMetadata(liveContext),
        citations: serializeCitations(liveContext.citations),
        createdAt: assistantCreatedAt,
      });
      await ftsUpsert(assistantMessageId, input.conversationId, circuitMessage);

      await db
        .update(conversations)
        .set({ updatedAt: new Date(), lastMode: "chat", runStatus: null })
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
      recordChannelSuccess(streamChannelId);
    } catch (error) {
      // A client disconnect aborts ctx.signal, which surfaces here as an abort
      // error. That is a normal cancellation, not a failure — keep whatever
      // partial content already streamed instead of overwriting it with an
      // "Error:" message that would be persisted as the assistant's reply.
      if (!ctx.signal.aborted) {
        const message = error instanceof Error ? error.message : "Stream error";
        responseContent = `Error: ${message}`;
        const classified = classifyProviderError(message);
        if (classified.retryable) {
          recordChannelFailure(streamChannelId);
        }
      }
    }

    await db
      .update(messages)
      .set({
        content: responseContent,
        model: resolvedChannel.modelId,
        liveMetadata: serializeLiveMetadata(liveContext),
        citations: serializeCitations(liveContext.citations),
        updatedAt: new Date(),
      })
      .where(eq(messages.id, assistantMessageId));
    await ftsUpsert(assistantMessageId, input.conversationId, responseContent);

    await db
      .update(conversations)
      .set({
        updatedAt: new Date(),
        lastMode: "chat",
        runStatus: null,
      })
      .where(eq(conversations.id, input.conversationId));

    // Fire-and-forget: generate summary if the conversation is long enough
    void maybeSummarize(userId, input.conversationId).catch(() => {});

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
    await ftsUpsert(userMessageId, userMsg.conversationId, newContent.trim());

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

    const chatMessages = await buildChatMessages(
      userId,
      contextMsgs,
      effectiveSystemPrompt,
      userMsg.conversationId,
    );

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
        updatedAt: new Date(),
      })
      .where(eq(messages.id, assistantMessageId));
    await ftsUpsert(assistantMessageId, userMsg.conversationId, responseContent);

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
    const chatMessages = await buildChatMessages(
      userId,
      contextMsgs,
      effectiveSystemPrompt,
      assistantMsg.conversationId,
    );

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
        updatedAt: new Date(),
      })
      .where(eq(messages.id, assistantMessageId));
    await ftsUpsert(assistantMessageId, assistantMsg.conversationId, responseContent);

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
      filePath: `${LOCAL_ATTACHMENT_PATH_PREFIX}${item.fileName}`,
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
    /**
     * Token counts for the turn. Optional throughout: not every runtime reports
     * them, and an older desktop build won't send them at all — so a missing
     * value means "not reported", never "zero".
     */
    usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
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
    where: and(eq(conversations.id, input.conversationId), eq(conversations.userId, userId)),
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
      await ftsUpsert(input.userMessageId, input.conversationId, input.userContent);
      await db
        .update(messages)
        .set({
          content: input.assistantContent,
          model: input.model || null,
          agentRun: input.agentRun ? JSON.stringify(input.agentRun) : null,
          // Regenerate re-runs the turn, so the previous count is stale — clear
          // it when the new run reported nothing rather than leaving the old one.
          usage: input.usage ? JSON.stringify(input.usage) : null,
          liveMetadata: null,
          citations: null,
          updatedAt: new Date(),
        })
        .where(eq(messages.id, input.assistantMessageId));
      await ftsUpsert(input.assistantMessageId, input.conversationId, input.assistantContent);
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
  await ftsUpsert(userMessageId, input.conversationId, input.userContent);

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
    usage: input.usage ? JSON.stringify(input.usage) : null,
    liveMetadata: null,
    citations: null,
    createdAt: new Date(now.getTime() + 1),
  });
  await ftsUpsert(assistantMessageId, input.conversationId, input.assistantContent);

  // Fire-and-forget: generate summary if the conversation is long enough
  void maybeSummarize(userId, input.conversationId).catch(() => {});

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
  await ftsUpsert(userMessageId, input.conversationId, input.content);

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
  const baseSystemPrompt = conversation.systemPrompt || settings[GLOBAL_SYSTEM_PROMPT_KEY] || null;

  const conversationMessages = await getMessages(input.conversationId);
  const chatMessages = await buildChatMessages(
    userId,
    conversationMessages,
    baseSystemPrompt,
    input.conversationId,
  );

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
  /** Token counts for the turn. Absent when the provider did not report them. */
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
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
      usage: input.usage ? JSON.stringify(input.usage) : null,
      updatedAt: new Date(),
    })
    .where(
      and(eq(messages.id, input.assistantMessageId), eq(messages.conversationId, conversation.id)),
    );
  await ftsUpsert(input.assistantMessageId, input.conversationId, input.content);

  await db
    .update(conversations)
    .set({ updatedAt: new Date(), lastMode: "chat", runStatus: null })
    .where(eq(conversations.id, conversation.id));

  // Fire-and-forget: generate summary if the conversation is long enough
  void maybeSummarize(userId, input.conversationId).catch(() => {});
}

// ---------------------------------------------------------------------------
// Full-text search over message content (FTS5)
// ---------------------------------------------------------------------------

function mapSearchRow(row: Record<string, unknown>) {
  return {
    messageId: String(row.message_id ?? ""),
    conversationId: String(row.conversation_id ?? ""),
    conversationTitle: String(row.conversation_title ?? ""),
    role: String(row.role ?? ""),
    snippet: String(row.snippet ?? ""),
    createdAt: Number(row.created_at ?? 0),
  };
}

export async function searchMessages(
  userId: string,
  query: string,
  limit = 50,
): Promise<
  Array<{
    messageId: string;
    conversationId: string;
    conversationTitle: string;
    role: string;
    snippet: string;
    createdAt: number;
  }>
> {
  const trimmed = query.trim();
  if (!trimmed) return [];

  // trigram FTS requires >= 3 chars
  if (trimmed.length >= 3) {
    const escaped = trimmed.replace(/"/g, '""');
    const result = await client.execute({
      sql: `SELECT f.message_id, f.conversation_id, substr(f.content, 1, 200) as snippet,
                   c.title AS conversation_title, m.role, m.created_at
            FROM messages_fts f
            JOIN conversations c ON c.id = f.conversation_id AND c.user_id = ?
            JOIN messages m ON m.id = f.message_id
            WHERE messages_fts MATCH ?
            ORDER BY rank
            LIMIT ?`,
      args: [userId, `"${escaped}"`, limit],
    });
    return (result.rows as Record<string, unknown>[]).map(mapSearchRow);
  }

  // < 3 chars: LIKE fallback
  const result = await client.execute({
    sql: `SELECT m.id as message_id, m.conversation_id, substr(m.content, 1, 200) as snippet,
                 c.title AS conversation_title, m.role, m.created_at
          FROM messages m
          JOIN conversations c ON c.id = m.conversation_id AND c.user_id = ?
          WHERE m.content LIKE ?
          ORDER BY m.created_at DESC
          LIMIT ?`,
    args: [userId, `%${trimmed}%`, limit],
  });
  return (result.rows as Record<string, unknown>[]).map(mapSearchRow);
}
