import { ChatStreamTruncatedError, type ChatUsage } from "adapters";
import { attachments, conversations, messages } from "db";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  boundChatContext,
  CHAT_MAX_CONTEXT_MESSAGES,
  CHAT_MAX_CONTEXT_TOKENS,
  ChatContextBudgetError,
  estimateContextMessageTokens,
} from "shared/context-budget";
import { resolveContextPolicy } from "shared/context-policy";
import {
  assistantFinishReason,
  assistantMessageContent,
  chatFailureFinishReason,
} from "shared/message-text";
import { type ChatContentPart, type ChatMessage, createAdapter } from "../agent-adapters";
import { client, db } from "../db";
import { generateId } from "../utils";
import { createSseStream, type SseContext, type SseEvent } from "../utils/sse";
import { withAppendedSystemPrompt } from "./appendSystemPrompt";
import {
  buildAttachmentPayloadFromIds,
  getEmbeddingApiKey,
  LOCAL_ATTACHMENT_PATH_PREFIX,
  linkAttachmentsToMessage,
  removeAttachmentFiles,
} from "./attachmentService";
import { getResolvedChannelForConversation } from "./channelService";
import { recordChannelFailure, recordChannelSuccess } from "./circuitBreaker";
import { buildLiveContext, type LiveContextResult, toStoredLiveMetadata } from "./liveCapabilities";
import { classifyLiveRouteWithModel } from "./liveRouteClassifier";
import { classifyProviderError } from "./providerErrorSummary";
import { retrieveContext } from "./ragService";
import { mergeSystemPromptParts, RESPONSE_STYLE_GUARDRAILS } from "./responseStyle";
import {
  type SearchCitation,
  TAVILY_API_KEY_SETTING,
  TAVILY_ENABLED_SETTING,
} from "./searchService";
import { getSettingValues } from "./settingsService";
import { getRecentSummaries, maybeSummarize } from "./summaryService";

const GLOBAL_SYSTEM_PROMPT_KEY = "chat.systemPrompt";
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

/**
 * Agent turns run only in the desktop sidecar. The server once planned
 * "task-backed" agent turns itself, but nothing executes or approves those any
 * more — a request for one would only produce a reply that never arrives. Every
 * entry point that would have started one rejects with this error instead.
 */
export class AgentModeUnsupportedError extends Error {
  readonly code = "agent_mode_unsupported";
  constructor() {
    super(
      "Agent mode runs in the desktop app's local runtime; the server does not execute agent turns.",
    );
    this.name = "AgentModeUnsupportedError";
  }
}

/** Preparation failed after creating a turn; retain its identity and safe end state. */
export class ChatTurnPreparationError extends Error {
  readonly finishReason: "context_budget_exceeded" | "error";
  readonly code: "chat_context_budget_exceeded" | "chat_preparation_failed";
  constructor(
    error: unknown,
    readonly userMessageId: string,
    readonly assistantMessageId: string,
  ) {
    super(error instanceof Error ? error.message : "Failed to prepare chat");
    this.name = "ChatTurnPreparationError";
    const budget = error instanceof ChatContextBudgetError;
    this.finishReason = budget ? "context_budget_exceeded" : "error";
    this.code = budget ? "chat_context_budget_exceeded" : "chat_preparation_failed";
  }
}

async function buildChatMessagesForTurn(
  userId: string,
  context: Parameters<typeof buildChatMessages>[1],
  systemPrompt: string | null,
  conversationId: string,
  turn: {
    userMessageId: string;
    assistantMessageId: string;
    model: string | null;
    createdAt?: Date;
    keepPrevious?: boolean;
    contextWindow?: number | null;
    protocol?: string;
  },
) {
  try {
    const policy = resolveContextPolicy({
      model: turn.model ?? "",
      protocol: turn.protocol,
      contextWindow: turn.contextWindow,
      mode: "chat",
    });
    return await buildChatMessages(userId, context, systemPrompt, conversationId, {
      maxTokens: policy.maxInputTokens,
      maxMessages: policy.maxMessages,
    });
  } catch (error) {
    const failure = new ChatTurnPreparationError(
      error,
      turn.userMessageId,
      turn.assistantMessageId,
    );
    // A failed zero-output retry keeps the previous answer and all its metadata.
    if (!turn.keepPrevious) {
      await db
        .insert(messages)
        .values({
          id: turn.assistantMessageId,
          conversationId,
          role: "assistant",
          content: "",
          model: turn.model,
          mode: "chat",
          finishReason: failure.finishReason,
          createdAt: turn.createdAt ?? new Date(),
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: messages.id,
          set: {
            content: "",
            model: turn.model,
            finishReason: failure.finishReason,
            usage: null,
            liveMetadata: null,
            citations: null,
            updatedAt: new Date(),
          },
        });
      await ftsDeleteMessage(turn.assistantMessageId);
    }
    throw failure;
  }
}

function createChatSseStream(
  handler: (send: (event: SseEvent) => void, ctx: SseContext) => Promise<void>,
) {
  return createSseStream(async (send, ctx) => {
    try {
      await handler(send, ctx);
    } catch (error) {
      if (!(error instanceof ChatTurnPreparationError)) throw error;
      send({
        type: "error",
        message: error.message,
        content: "",
        messageId: error.assistantMessageId,
        ...(error.code === "chat_context_budget_exceeded" ? { errorCode: error.code } : {}),
      });
    }
  });
}

export class ChatModeUnsupportedError extends Error {
  readonly code = "chat_mode_unsupported";
  constructor() {
    super("ACP 渠道仅支持桌面端 Agent 模式，请切换到 Agent 模式后重试。");
    this.name = "ChatModeUnsupportedError";
  }
}

async function resolveChatChannelForConversation(
  userId: string,
  conversation: Parameters<typeof getResolvedChannelForConversation>[1],
) {
  const resolved = await getResolvedChannelForConversation(userId, conversation);
  if (resolved?.channel.protocol === "acp") throw new ChatModeUnsupportedError();
  return resolved;
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
  /** Only "chat" is served; anything else is an agent request and is rejected. */
  mode?: "chat" | "agent";
}

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

export async function buildChatMessages(
  userId: string,
  conversationMessages: Array<{ role: string; content: string; attachments?: string | null }>,
  systemPrompt?: string | null,
  conversationId?: string | null,
  limits: { maxTokens?: number; maxMessages?: number } = {},
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

  // RAG context injection — retrieve relevant document chunks for the user's
  // latest query and append them to the system prompt so the model can reference
  // uploaded documents during the conversation.
  const lastUserMsg = conversationMessages.filter((m) => m.role === "user").pop();
  if (lastUserMsg) {
    try {
      const embeddingCreds = await getEmbeddingApiKey(userId);
      if (embeddingCreds) {
        const ragContext = await retrieveContext(
          lastUserMsg.content,
          userId,
          embeddingCreds.apiKey,
          embeddingCreds.baseUrl,
        );
        if (ragContext) {
          effectiveSystemPrompt = `${effectiveSystemPrompt || ""}\n\n## 相关文档上下文\n\n${ragContext}`;
        }
      }
    } catch {
      // RAG retrieval failure must not block normal conversation
    }
  }

  if (effectiveSystemPrompt) {
    appendChatMessage(chatMessages, "system", effectiveSystemPrompt);
  }

  // Bound attachment expansion work before fetching old files. Retain the
  // current request even when pathological trailing rows exceed the coarse
  // cap; the final budget below always validates the actual expanded payload.
  let currentUserIndex = conversationMessages.length - 1;
  while (currentUserIndex >= 0 && conversationMessages[currentUserIndex]?.role !== "user") {
    currentUserIndex--;
  }
  const startIndex = Math.min(
    Math.max(0, conversationMessages.length - (limits.maxMessages ?? CHAT_MAX_CONTEXT_MESSAGES)),
    Math.max(0, currentUserIndex),
  );
  const coarseMessages = conversationMessages.filter(
    (message, index) => index >= startIndex || message.role === "system",
  );
  type StoredMessage = (typeof coarseMessages)[number];
  const expandMessage = async (message: StoredMessage): Promise<ChatMessage | null> => {
    if (message.role !== "user" && message.role !== "assistant" && message.role !== "system") {
      return null;
    }
    if (message.role === "user" && message.attachments) {
      let attachmentIds: string[] = [];
      try {
        attachmentIds = JSON.parse(message.attachments) as string[];
      } catch {
        attachmentIds = [];
      }
      const content = await buildUserContentWithAttachments(userId, message.content, attachmentIds);
      const normalized = normalizeChatContent(content);
      return normalized ? { role: "user", content: normalized } : null;
    }
    const normalized = normalizeChatContent(message.content);
    return normalized ? { role: message.role, content: normalized } : null;
  };

  // Instructions and the current turn are protected before old attachments are
  // fetched. Expand older question/answer groups newest-first; once a group no
  // longer fits, no earlier attachment can belong to the contiguous suffix.
  for (const message of coarseMessages.filter((message) => message.role === "system")) {
    const expanded = await expandMessage(message);
    if (expanded) chatMessages.push(expanded);
  }
  const turns = coarseMessages.filter(
    (message) => message.role === "user" || message.role === "assistant",
  );
  let currentTurnIndex = turns.length - 1;
  while (currentTurnIndex >= 0 && turns[currentTurnIndex]?.role !== "user") currentTurnIndex--;
  const current: ChatMessage[] = [];
  for (const message of turns.slice(Math.max(0, currentTurnIndex))) {
    const expanded = await expandMessage(message);
    if (expanded) current.push(expanded);
  }
  const protectedMessages = [...chatMessages, ...current];
  boundChatContext(protectedMessages, limits);
  let tokenCount = protectedMessages.reduce(
    (sum, message) => sum + estimateContextMessageTokens(message),
    0,
  );
  let messageCount = protectedMessages.length;
  const historicalRows = turns.slice(0, Math.max(0, currentTurnIndex));
  const groups: StoredMessage[][] = [];
  for (const message of historicalRows) {
    if (message.role === "user") groups.push([message]);
    else groups.at(-1)?.push(message);
  }
  const expandedGroups: ChatMessage[][] = [];
  let expandedHistoryRows = 0;
  for (let index = groups.length - 1; index >= 0; index--) {
    const group = groups[index];
    if (!group) continue;
    const expanded: ChatMessage[] = [];
    for (const message of group) {
      const normalized = await expandMessage(message);
      if (normalized) expanded.push(normalized);
    }
    expandedHistoryRows += group.length;
    expandedGroups.push(expanded);
    tokenCount += expanded.reduce((sum, message) => sum + estimateContextMessageTokens(message), 0);
    messageCount += expanded.length;
    if (
      tokenCount > (limits.maxTokens ?? CHAT_MAX_CONTEXT_TOKENS) ||
      messageCount > (limits.maxMessages ?? CHAT_MAX_CONTEXT_MESSAGES)
    ) {
      break;
    }
  }
  const expandedMessages = [...chatMessages, ...expandedGroups.reverse().flat(), ...current];
  const bounded: ChatMessage[] = [];
  for (const message of boundChatContext(expandedMessages, {
    ...limits,
    omittedMessages:
      conversationMessages.length -
      coarseMessages.length +
      historicalRows.length -
      expandedHistoryRows,
  })) {
    appendChatMessage(bounded, message.role, message.content);
  }
  return bounded;
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
  // Stored rows are final: agent turns are persisted by the sidecar once they
  // end, and the legacy server-run (task-backed) turns were settled by a
  // one-time bootstrap migration — nothing on the read path needs re-syncing.
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
  if (input.mode !== undefined && input.mode !== "chat") {
    throw new AgentModeUnsupportedError();
  }
  const conversation = await getConversationForUser(userId, input.conversationId);
  const resolvedChannel = await resolveChatChannelForConversation(userId, conversation);

  const userMessageId = generateId();
  const now = new Date();

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

  await db
    .update(conversations)
    .set({ updatedAt: now })
    .where(eq(conversations.id, input.conversationId));

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
  const assistantMessageId = generateId();
  const chatMessages = await buildChatMessagesForTurn(
    userId,
    conversationMessages,
    buildEffectiveSystemPrompt(conversation.systemPrompt, liveContext),
    input.conversationId,
    {
      userMessageId,
      assistantMessageId,
      model: resolvedChannel?.modelId ?? null,
      contextWindow: resolvedChannel?.contextWindow,
      protocol: resolvedChannel?.channel.protocol,
    },
  );

  let responseContent = "";
  let responseUsage: ChatUsage | undefined;
  let responseErrorCode: "response_truncated" | undefined;
  let responseFailed = false;
  let responseModel: string | null = null;

  if (resolvedChannel) {
    const channelId = resolvedChannel.channel.id;
    const adapter = createAdapter(
      resolvedChannel.channel.protocol,
      resolvedChannel.apiKey,
      resolvedChannel.channel.baseUrl || undefined,
    );
    responseModel = resolvedChannel.modelId;

    // Failure metadata stays separate from exact accumulated model text,
    // including empty output and unfinished UI programs.
    try {
      const stream = await adapter.chatStream({
        model: resolvedChannel.modelId,
        messages: chatMessages,
        maxTokens: resolveContextPolicy({
          model: resolvedChannel.modelId,
          protocol: resolvedChannel.channel.protocol,
          contextWindow: resolvedChannel.contextWindow,
          mode: "chat",
        }).maxOutputTokens,
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
      if (error instanceof ChatStreamTruncatedError) {
        responseErrorCode = error.code;
        responseUsage = error.usage;
      } else {
        responseFailed = true;
      }
      const classified = classifyProviderError(message);
      if (classified.retryable) {
        recordChannelFailure(channelId);
      }
    }
  } else {
    responseContent = conversation.channelId
      ? "该对话选择的渠道/模型不可用（可能已被禁用或已删除）。请在对话中重新选择模型。"
      : "未配置可用的默认渠道/默认模型。请先在设置中完成配置后再开始对话。";
  }

  await db.insert(messages).values({
    id: assistantMessageId,
    conversationId: input.conversationId,
    role: "assistant",
    content: responseContent,
    usage: responseUsage ? JSON.stringify(responseUsage) : null,
    finishReason: responseErrorCode ? "length" : responseFailed ? "error" : null,
    model: responseModel,
    mode: "chat",
    agentRun: null,
    liveMetadata: serializeLiveMetadata(liveContext),
    citations: serializeCitations(liveContext.citations),
    createdAt: new Date(),
  });
  await ftsUpsert(assistantMessageId, input.conversationId, responseContent);

  // Fire-and-forget: generate summary if the conversation is long enough
  void maybeSummarize(userId, input.conversationId).catch(() => {});

  return {
    ...(responseErrorCode ? { errorCode: responseErrorCode } : {}),
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
      finishReason: responseErrorCode
        ? ("length" as const)
        : responseFailed
          ? ("error" as const)
          : null,
      ...(responseUsage ? { usage: responseUsage } : {}),
      createdAt: new Date(),
    },
  };
}

export async function deleteMessage(userId: string, messageId: string) {
  const message = await db.select().from(messages).where(eq(messages.id, messageId)).limit(1);

  if (message.length === 0) {
    // DELETE is idempotent, including a local result whose first save failed.
    return { success: true };
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
  // An omitted mode used to mean "agent" here, so only an explicit "chat" is
  // served — rejected before the stream opens, so the caller gets a 4xx.
  if (input.mode !== "chat") {
    throw new AgentModeUnsupportedError();
  }
  const conversation = await getConversationForUser(userId, input.conversationId);
  const resolvedChannel = await resolveChatChannelForConversation(userId, conversation);
  return createChatSseStream(async (send, ctx) => {
    const userMessageId = generateId();
    const now = new Date();
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
      .set({
        updatedAt: now,
        lastMode: "chat",
        runStatus: null,
      })
      .where(eq(conversations.id, input.conversationId));

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
    const chatMessages = await buildChatMessagesForTurn(
      userId,
      conversationMessages,
      effectiveSystemPrompt,
      input.conversationId,
      {
        userMessageId,
        assistantMessageId,
        model: resolvedChannel?.modelId ?? null,
        contextWindow: resolvedChannel?.contextWindow,
        protocol: resolvedChannel?.channel.protocol,
        createdAt: assistantCreatedAt,
      },
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

    const {
      content: responseContent,
      stopped,
      error: streamError,
      errorCode,
      usage,
    } = await streamReplyUntilStopped(
      adapter,
      {
        model: resolvedChannel.modelId,
        messages: chatMessages,
        signal: ctx.signal,
        contextWindow: resolvedChannel.contextWindow,
        protocol: resolvedChannel.channel.protocol,
      },
      send,
    );
    if (streamError) {
      const classified = classifyProviderError(streamError);
      if (classified.retryable) recordChannelFailure(streamChannelId);
    } else if (!stopped) recordChannelSuccess(streamChannelId);

    await db
      .update(messages)
      .set({
        content: responseContent,
        model: resolvedChannel.modelId,
        liveMetadata: serializeLiveMetadata(liveContext),
        citations: serializeCitations(liveContext.citations),
        finishReason: assistantFinishReason(
          stopped ? "stopped" : streamError ? chatFailureFinishReason(errorCode) : null,
          null,
        ),
        usage: usage ? JSON.stringify(usage) : null,
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

    send(
      streamError
        ? {
            type: "error",
            message: streamError,
            content: responseContent,
            ...(errorCode ? { errorCode } : {}),
            ...(usage ? { usage } : {}),
            messageId: assistantMessageId,
            model: resolvedChannel.modelId,
          }
        : {
            type: "done",
            messageId: assistantMessageId,
            model: resolvedChannel.modelId,
            ...(usage ? { usage } : {}),
          },
    );
  });
}

/**
 * Streams a chat reply to the client and returns its text. A client stop (the
 * request is aborted, which aborts `signal`) is "stop generating", not a
 * failure: the text streamed so far is returned — with `stopped` set, so the
 * caller stores the reply as stopped — and persisted like any finished reply.
 * Provider failures retain the accumulated text and report their error separately,
 * so every caller can persist the partial reply before emitting its terminal event.
 */
async function streamReplyUntilStopped(
  adapter: ReturnType<typeof createAdapter>,
  input: {
    model: string;
    messages: ChatMessage[];
    signal: AbortSignal;
    contextWindow?: number | null;
    protocol?: string;
  },
  send: (event: { type: string; [key: string]: unknown }) => void,
): Promise<{
  content: string;
  stopped: boolean;
  error?: string;
  errorCode?: "response_truncated";
  usage?: ChatUsage;
}> {
  let responseContent = "";
  let streamError: string | undefined;
  let errorCode: "response_truncated" | undefined;
  let usage: ChatUsage | undefined;
  try {
    const stream = await adapter.chatStream({
      model: input.model,
      messages: input.messages,
      maxTokens: resolveContextPolicy({
        model: input.model,
        protocol: input.protocol,
        contextWindow: input.contextWindow,
        mode: "chat",
      }).maxOutputTokens,
      signal: input.signal,
    });
    while (true) {
      const step = await stream.next();
      if (step.done) {
        usage = step.value;
        break;
      }
      const chunk = step.value;
      if (typeof chunk !== "string" || chunk.length === 0) continue;
      responseContent += chunk;
      send({ type: "delta", content: chunk });
    }
  } catch (error) {
    if (!input.signal.aborted) {
      streamError = error instanceof Error ? error.message : "Stream error";
      if (error instanceof ChatStreamTruncatedError) {
        errorCode = error.code;
        usage = error.usage;
      }
    }
  }
  // Read once the stream has ended, however it ended: some adapters end the
  // iteration quietly on abort instead of throwing.
  return {
    content: responseContent,
    stopped: input.signal.aborted,
    error: streamError,
    errorCode,
    usage,
  };
}

/**
 * Edit-and-resend replays the round as the mode of its reply (or, when the user
 * message is the conversation tail, of the user message). An agent round is
 * re-run by the sidecar, never here — reject it before the stream opens so the
 * caller gets a 4xx instead of an SSE error. Resolve capability only after
 * ownership, before any edit. Missing messages keep their existing SSE error.
 */
async function prepareEditedChatTurn(userId: string, userMessageId: string) {
  const [userMsg] = await db.select().from(messages).where(eq(messages.id, userMessageId));
  if (!userMsg || userMsg.role !== "user") return;
  const conversation = await getConversationForUser(userId, userMsg.conversationId);
  const allMsgs = await getMessages(userMsg.conversationId);
  const idx = allMsgs.findIndex((m) => m.id === userMessageId);
  if (idx < 0) return;
  const nextMsg = allMsgs[idx + 1];
  if ((nextMsg?.mode ?? userMsg.mode) === "agent") {
    throw new AgentModeUnsupportedError();
  }
  const resolvedChannel = await resolveChatChannelForConversation(userId, conversation);
  return { userMsg, conversation, allMsgs, idx, resolvedChannel };
}

export async function editUserMessage(
  userId: string,
  userMessageId: string,
  newContent: string,
  options?: {
    /** Per-call system-prompt addendum; used for this LLM call only, never persisted. */
    appendSystemPrompt?: string;
  },
): Promise<ReadableStream> {
  const prepared = await prepareEditedChatTurn(userId, userMessageId);
  return createChatSseStream(async (send, ctx) => {
    if (!prepared) {
      send({ type: "error", message: "Message not found" });
      return;
    }
    const { userMsg, conversation, allMsgs, idx, resolvedChannel } = prepared;

    const nextMsg = idx >= 0 ? allMsgs[idx + 1] : null;
    const shouldCreateAssistantReply = !nextMsg;
    if (nextMsg && nextMsg.role !== "assistant") {
      send({ type: "error", message: "找不到对应的 AI 回复消息" });
      return;
    }
    const assistantMessageId = nextMsg?.id ?? generateId();

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
    const effectiveSystemPrompt = withAppendedSystemPrompt(
      buildEffectiveSystemPrompt(baseSystemPrompt, liveContext),
      options?.appendSystemPrompt,
    );
    send(buildLiveStatusPayload(liveContext));
    const citationsPayload = buildCitationsPayload(liveContext.citations);
    if (citationsPayload) {
      send(citationsPayload);
    }

    const chatMessages = await buildChatMessagesForTurn(
      userId,
      contextMsgs,
      effectiveSystemPrompt,
      userMsg.conversationId,
      {
        userMessageId,
        assistantMessageId,
        model: resolvedChannel?.modelId ?? null,
        contextWindow: resolvedChannel?.contextWindow,
        protocol: resolvedChannel?.channel.protocol,
      },
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

    const {
      content: responseContent,
      stopped,
      error: streamError,
      errorCode,
      usage,
    } = await streamReplyUntilStopped(
      adapter,
      {
        model: resolvedChannel.modelId,
        messages: chatMessages,
        signal: ctx.signal,
        contextWindow: resolvedChannel.contextWindow,
        protocol: resolvedChannel.channel.protocol,
      },
      send,
    );

    await db
      .update(messages)
      .set({
        content: responseContent,
        model: resolvedChannel.modelId,
        liveMetadata: serializeLiveMetadata(liveContext),
        citations: serializeCitations(liveContext.citations),
        finishReason: assistantFinishReason(
          stopped ? "stopped" : streamError ? chatFailureFinishReason(errorCode) : null,
          null,
        ),
        usage: usage ? JSON.stringify(usage) : null,
        updatedAt: new Date(),
      })
      .where(eq(messages.id, assistantMessageId));
    await ftsUpsert(assistantMessageId, userMsg.conversationId, responseContent);

    send(
      streamError
        ? {
            type: "error",
            message: streamError,
            content: responseContent,
            ...(errorCode ? { errorCode } : {}),
            ...(usage ? { usage } : {}),
            messageId: assistantMessageId,
            model: resolvedChannel.modelId,
          }
        : {
            type: "done",
            messageId: assistantMessageId,
            model: resolvedChannel.modelId,
            ...(usage ? { usage } : {}),
          },
    );
  });
}

export async function regenerateMessage(
  userId: string,
  assistantMessageId: string,
  fallback?: {
    fallbackUserMessageId?: string;
    fallbackUserContent?: string;
    /** Per-call system-prompt addendum; used for this LLM call only, never persisted. */
    appendSystemPrompt?: string;
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
    return editUserMessage(userId, fallback.fallbackUserMessageId, fallback.fallbackUserContent, {
      appendSystemPrompt: fallback.appendSystemPrompt,
    });
  }

  if (!prefetchedAssistantMsg || prefetchedAssistantMsg.role !== "assistant") {
    return createChatSseStream(async (send) => {
      send({ type: "error", message: "Message not found" });
    });
  }
  const assistantMsg = prefetchedAssistantMsg;
  const conversation = await getConversationForUser(userId, assistantMsg.conversationId);
  // An agent reply is regenerated by the sidecar, never here.
  if (assistantMsg.mode === "agent") {
    throw new AgentModeUnsupportedError();
  }
  const resolvedChannel = await resolveChatChannelForConversation(userId, conversation);

  return createChatSseStream(async (send, ctx) => {
    const allMsgs = await getMessages(assistantMsg.conversationId);
    const idx = allMsgs.findIndex((m) => m.id === assistantMessageId);
    const contextMsgs = idx > 0 ? allMsgs.slice(0, idx) : allMsgs;
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
    const effectiveSystemPrompt = withAppendedSystemPrompt(
      buildEffectiveSystemPrompt(baseSystemPrompt, liveContext),
      fallback?.appendSystemPrompt,
    );
    send(buildLiveStatusPayload(liveContext));
    const citationsPayload = buildCitationsPayload(liveContext.citations);
    if (citationsPayload) {
      send(citationsPayload);
    }
    const chatMessages = await buildChatMessagesForTurn(
      userId,
      contextMsgs,
      effectiveSystemPrompt,
      assistantMsg.conversationId,
      {
        userMessageId: lastUserMessage?.id ?? "",
        assistantMessageId,
        model: resolvedChannel?.modelId ?? null,
        contextWindow: resolvedChannel?.contextWindow,
        protocol: resolvedChannel?.channel.protocol,
        keepPrevious: true,
      },
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

    const {
      content: responseContent,
      stopped,
      error: streamError,
      errorCode,
      usage,
    } = await streamReplyUntilStopped(
      adapter,
      {
        model: resolvedChannel.modelId,
        messages: chatMessages,
        signal: ctx.signal,
        contextWindow: resolvedChannel.contextWindow,
        protocol: resolvedChannel.channel.protocol,
      },
      send,
    );
    // Stopped before anything was generated: nothing replaces the previous
    // reply, so it stays as it was (its own finish reason included).
    if ((stopped || streamError) && !responseContent) {
      if (streamError)
        send({
          type: "error",
          message: streamError,
          content: responseContent,
          ...(errorCode ? { errorCode } : {}),
          ...(usage ? { usage } : {}),
          messageId: assistantMessageId,
          model: resolvedChannel.modelId,
        });
      return;
    }

    await db
      .update(messages)
      .set({
        content: responseContent,
        model: resolvedChannel.modelId,
        liveMetadata: serializeLiveMetadata(liveContext),
        citations: serializeCitations(liveContext.citations),
        finishReason: assistantFinishReason(
          stopped ? "stopped" : streamError ? chatFailureFinishReason(errorCode) : null,
          null,
        ),
        usage: usage ? JSON.stringify(usage) : null,
        updatedAt: new Date(),
      })
      .where(eq(messages.id, assistantMessageId));
    await ftsUpsert(assistantMessageId, assistantMsg.conversationId, responseContent);

    send(
      streamError
        ? {
            type: "error",
            message: streamError,
            content: responseContent,
            ...(errorCode ? { errorCode } : {}),
            ...(usage ? { usage } : {}),
            messageId: assistantMessageId,
            model: resolvedChannel.modelId,
          }
        : {
            type: "done",
            messageId: assistantMessageId,
            model: resolvedChannel.modelId,
            ...(usage ? { usage } : {}),
          },
    );
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
  writer: Pick<typeof db, "insert"> = db,
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
  await writer.insert(attachments).values(rows);
}

function modeForLatestUserRequest(
  conversationId: string,
  userMessageId: string,
  mode: "chat" | "agent",
) {
  // Retrying an older round must not replace the mode of a later request.
  // Check at UPDATE time so a request accepted during persistence also wins.
  // SQLite timestamps have second precision; rowid preserves insertion order
  // even when two user requests have the same timestamp.
  return sql`CASE WHEN ${userMessageId} = (
    SELECT id FROM messages
    WHERE conversation_id = ${conversationId} AND role = 'user'
    ORDER BY rowid DESC LIMIT 1
  ) THEN ${mode} ELSE ${conversations.lastMode} END`;
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
    usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
    finishReason?: unknown;
    attachmentsMeta?: Array<{ fileName: string; fileType?: string; fileSize?: number }>;
    userMessageId?: string;
    assistantMessageId?: string;
    /** Idempotent reply creation for a previously persisted, unanswered user. */
    newAssistantMessageId?: string;
    /** Orders saves from one running desktop session; not a cross-client CAS. */
    syncRevision?: { sessionId: string; sequence: number };
  },
) {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const revision = input.syncRevision;
  if (
    revision !== undefined &&
    (!revision ||
      typeof revision !== "object" ||
      Array.isArray(revision) ||
      typeof revision.sessionId !== "string" ||
      !uuid.test(revision.sessionId) ||
      !Number.isSafeInteger(revision.sequence) ||
      revision.sequence < 1)
  ) {
    throw new Error("Invalid sidecar sync revision");
  }
  if (input.assistantMessageId && !input.userMessageId)
    throw new Error("Both message ids are required");
  if (input.newAssistantMessageId && (!input.userMessageId || input.assistantMessageId)) {
    throw new Error("New assistant id requires only an existing user id");
  }
  for (const id of [input.userMessageId, input.assistantMessageId, input.newAssistantMessageId]) {
    if (id !== undefined && (typeof id !== "string" || id.length === 0))
      throw new Error("Invalid message id");
  }
  const mode = input.mode === "chat" ? "chat" : "agent";
  const assistantContent = assistantMessageContent(input.assistantContent ?? "", input.agentRun);
  const finishReason = assistantFinishReason(
    mode === "agent" && input.finishReason !== "stopped" ? null : input.finishReason,
    input.agentRun,
  );
  if (
    revision &&
    (!input.agentRun || typeof input.agentRun !== "object" || Array.isArray(input.agentRun))
  ) {
    throw new Error("A sync revision requires an Agent run");
  }
  const storedRun = revision
    ? { ...(input.agentRun as object), _syncRevision: revision }
    : input.agentRun;
  const now = new Date();
  const result = await db.transaction(async (tx) => {
    const conversation = await tx.query.conversations.findFirst({
      where: and(eq(conversations.id, input.conversationId), eq(conversations.userId, userId)),
    });
    if (!conversation) throw new Error("Conversation not found");
    const existingUser = input.userMessageId
      ? await tx.query.messages.findFirst({ where: eq(messages.id, input.userMessageId) })
      : undefined;
    const requestedAssistant = input.assistantMessageId ?? input.newAssistantMessageId;
    const existingAssistant = requestedAssistant
      ? await tx.query.messages.findFirst({ where: eq(messages.id, requestedAssistant) })
      : undefined;
    for (const [message, role] of [
      [existingUser, "user"],
      [existingAssistant, "assistant"],
    ] as const) {
      if (message && (message.conversationId !== input.conversationId || message.role !== role)) {
        throw new Error("Message identity does not belong to this conversation and role");
      }
    }
    if (input.assistantMessageId && Boolean(existingUser) !== Boolean(existingAssistant)) {
      throw new Error("The message pair is incomplete");
    }
    if (input.newAssistantMessageId && !existingUser) throw new Error("User message not found");
    // Imported/legacy rows may have opaque TEXT identifiers. Only newly created
    // client-selected IDs need UUIDs; existing IDs are validated by role and owner.
    if (
      (!existingUser && input.assistantMessageId && !uuid.test(input.userMessageId ?? "")) ||
      (!existingAssistant && requestedAssistant && !uuid.test(requestedAssistant))
    ) {
      throw new Error("New message ids must be UUIDs");
    }
    const userMessageId =
      existingUser?.id ??
      (input.assistantMessageId ? input.userMessageId : undefined) ??
      generateId();
    const assistantMessageId = requestedAssistant ?? generateId();
    if (userMessageId === assistantMessageId) throw new Error("Message ids must be distinct");
    if (revision && existingAssistant?.agentRun) {
      let previous: unknown;
      try {
        previous = JSON.parse(existingAssistant.agentRun)?._syncRevision;
      } catch {
        /* legacy run */
      }
      if (
        previous &&
        typeof previous === "object" &&
        "sessionId" in previous &&
        "sequence" in previous &&
        previous.sessionId === revision.sessionId &&
        typeof previous.sequence === "number" &&
        previous.sequence >= revision.sequence
      ) {
        // ACK loss may repeat the same save; an older request cannot overwrite a newer run.
        return { userMessageId, assistantMessageId, changed: false, inserted: false };
      }
    }
    if (existingUser) {
      await tx
        .update(messages)
        .set({ content: input.userContent })
        .where(eq(messages.id, userMessageId));
    } else {
      await tx.insert(messages).values({
        id: userMessageId,
        conversationId: input.conversationId,
        role: "user",
        content: input.userContent,
        mode,
        attachments: null,
        agentRun: null,
        createdAt: now,
      });
    }
    const values = {
      content: assistantContent,
      model: input.model || null,
      mode,
      agentRun: storedRun ? JSON.stringify(storedRun) : null,
      usage: input.usage ? JSON.stringify(input.usage) : null,
      finishReason,
      liveMetadata: null,
      citations: null,
    };
    if (existingAssistant) {
      await tx
        .update(messages)
        .set({ ...values, updatedAt: now })
        .where(eq(messages.id, assistantMessageId));
    } else {
      await tx.insert(messages).values({
        ...values,
        id: assistantMessageId,
        conversationId: input.conversationId,
        role: "assistant",
        attachments: null,
        createdAt: existingUser
          ? new Date(Math.max(now.getTime(), existingUser.createdAt.getTime() + 1000))
          : new Date(now.getTime() + 1),
      });
    }
    if (Array.isArray(input.attachmentsMeta)) {
      await tx.delete(attachments).where(eq(attachments.messageId, userMessageId));
      await insertSidecarAttachmentMeta(
        input.conversationId,
        userMessageId,
        input.attachmentsMeta,
        now,
        tx,
      );
    }
    await tx
      .update(conversations)
      .set({
        updatedAt: now,
        lastMode: modeForLatestUserRequest(input.conversationId, userMessageId, mode),
      })
      .where(and(eq(conversations.id, input.conversationId), eq(conversations.userId, userId)));
    // Keep search in the same save order as the primary rows. Post-commit FTS
    // writes from an older request could otherwise overtake a newer revision.
    try {
      for (const [id, content] of [
        [userMessageId, input.userContent],
        [assistantMessageId, assistantContent],
      ]) {
        await tx.run(sql`DELETE FROM messages_fts WHERE message_id = ${id}`);
        if (content)
          await tx.run(
            sql`INSERT INTO messages_fts(message_id, conversation_id, content) VALUES (${id}, ${input.conversationId}, ${content.substring(0, 5000)})`,
          );
      }
    } catch {
      // FTS is optional in databases that have not bootstrapped its virtual table.
    }
    return { userMessageId, assistantMessageId, changed: true, inserted: !existingAssistant };
  });
  if (result.changed) {
    if (result.inserted) void maybeSummarize(userId, input.conversationId).catch(() => {});
  }
  return { userMessageId: result.userMessageId, assistantMessageId: result.assistantMessageId };
}

export interface PrepareChatInput {
  conversationId: string;
  content: string;
  attachments?: string[];
}

export interface PrepareChatResult {
  contextWindow: number;
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
  const resolvedChannel = await resolveChatChannelForConversation(userId, conversation);
  if (!resolvedChannel) {
    const message = conversation.channelId
      ? "该对话选择的渠道/模型不可用（可能已被禁用或已删除）。请在对话中重新选择模型。"
      : "未配置可用的默认渠道/默认模型。请先在设置中完成配置后再开始对话。";
    throw new Error(message);
  }

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
    .set({
      updatedAt: now,
      lastMode: modeForLatestUserRequest(input.conversationId, userMessageId, "chat"),
      runStatus: null,
    })
    .where(eq(conversations.id, input.conversationId));

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
  const chatMessages = await buildChatMessagesForTurn(
    userId,
    conversationMessages,
    baseSystemPrompt,
    input.conversationId,
    {
      userMessageId,
      assistantMessageId,
      model: resolvedChannel.modelId,
      contextWindow: resolvedChannel.contextWindow,
      protocol: resolvedChannel.channel.protocol,
      createdAt: assistantCreatedAt,
    },
  );

  return {
    contextWindow: resolveContextPolicy({
      model: resolvedChannel.modelId,
      protocol: resolvedChannel.channel.protocol,
      contextWindow: resolvedChannel.contextWindow,
      mode: "chat",
    }).contextWindow,
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
  /** Chat accepts "stopped" or explicit output-limit "length"; otherwise null. */
  finishReason?: unknown;
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
      finishReason: assistantFinishReason(input.finishReason, null),
      updatedAt: new Date(),
    })
    .where(
      and(eq(messages.id, input.assistantMessageId), eq(messages.conversationId, conversation.id)),
    );
  await ftsUpsert(input.assistantMessageId, input.conversationId, input.content);

  await db
    .update(conversations)
    // Preparation saved the request's mode. Completion can arrive after a
    // newer Agent request and must not replace that later user choice.
    .set({ updatedAt: new Date(), runStatus: null })
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
