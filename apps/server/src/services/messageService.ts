import { attachments, conversations, messages } from "db";
import { and, asc, eq, inArray } from "drizzle-orm";
import { assistantMessageContent } from "shared/message-text";
import { type ChatContentPart, type ChatMessage, createAdapter } from "../agent-adapters";
import { client, db } from "../db";
import { generateId } from "../utils";
import { createSseStream } from "../utils/sse";
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
  // An omitted mode used to mean "agent" here, so only an explicit "chat" is
  // served — rejected before the stream opens, so the caller gets a 4xx.
  if (input.mode !== "chat") {
    throw new AgentModeUnsupportedError();
  }
  return createSseStream(async (send, ctx) => {
    const conversation = await getConversationForUser(userId, input.conversationId);

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

/**
 * Edit-and-resend replays the round as the mode of its reply (or, when the user
 * message is the conversation tail, of the user message). An agent round is
 * re-run by the sidecar, never here — reject it before the stream opens so the
 * caller gets a 4xx instead of an SSE error. Missing / foreign messages fall
 * through to the stream, which reports them as before.
 */
async function assertEditTargetsChatTurn(userId: string, userMessageId: string) {
  const [userMsg] = await db.select().from(messages).where(eq(messages.id, userMessageId));
  if (!userMsg || userMsg.role !== "user") return;
  await getConversationForUser(userId, userMsg.conversationId);
  const allMsgs = await getMessages(userMsg.conversationId);
  const idx = allMsgs.findIndex((m) => m.id === userMessageId);
  if (idx < 0) return;
  const nextMsg = allMsgs[idx + 1];
  if ((nextMsg?.mode ?? userMsg.mode) === "agent") {
    throw new AgentModeUnsupportedError();
  }
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
  await assertEditTargetsChatTurn(userId, userMessageId);
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
    const effectiveSystemPrompt = withAppendedSystemPrompt(
      buildEffectiveSystemPrompt(baseSystemPrompt, liveContext),
      options?.appendSystemPrompt,
    );
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

  // An agent reply is regenerated by the sidecar, never here.
  if (prefetchedAssistantMsg?.role === "assistant" && prefetchedAssistantMsg.mode === "agent") {
    await getConversationForUser(userId, prefetchedAssistantMsg.conversationId);
    throw new AgentModeUnsupportedError();
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
    const effectiveSystemPrompt = withAppendedSystemPrompt(
      buildEffectiveSystemPrompt(baseSystemPrompt, liveContext),
      fallback?.appendSystemPrompt,
    );
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
    // new pair — otherwise editing would duplicate the round on reload. With only
    // `userMessageId`, that user message is updated and a reply inserted.
    userMessageId?: string;
    assistantMessageId?: string;
  },
) {
  const conversation = await db.query.conversations.findFirst({
    where: and(eq(conversations.id, input.conversationId), eq(conversations.userId, userId)),
  });
  if (!conversation) throw new Error("Conversation not found");

  const now = new Date();
  // The reply text of an agent run lives in its text steps; `content` must equal
  // it no matter what the client sent (older builds sent "" or the error text).
  // A run without text steps stores "" — its failure, if any, is agentRun.error.
  const assistantContent = assistantMessageContent(input.assistantContent ?? "", input.agentRun);

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
          content: assistantContent,
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
      await ftsUpsert(input.assistantMessageId, input.conversationId, assistantContent);
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

  // Only the user id: edit-and-resend of a user message that never got a reply.
  // The user message is updated in place and the reply is inserted after it —
  // inserting a fresh pair would duplicate the question on reload.
  const existingUserOnly =
    input.userMessageId && !input.assistantMessageId
      ? await db.query.messages.findFirst({
          where: and(
            eq(messages.id, input.userMessageId),
            eq(messages.conversationId, input.conversationId),
            eq(messages.role, "user"),
          ),
        })
      : undefined;

  const userMessageId = existingUserOnly?.id ?? generateId();
  const assistantMessageId = generateId();

  if (existingUserOnly) {
    await db
      .update(messages)
      .set({ content: input.userContent })
      .where(eq(messages.id, userMessageId));
    await ftsUpsert(userMessageId, input.conversationId, input.userContent);
    if (Array.isArray(input.attachmentsMeta)) {
      await db.delete(attachments).where(eq(attachments.messageId, userMessageId));
      await insertSidecarAttachmentMeta(
        input.conversationId,
        userMessageId,
        input.attachmentsMeta,
        now,
      );
    }
  } else {
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
  }

  await db.insert(messages).values({
    id: assistantMessageId,
    conversationId: input.conversationId,
    role: "assistant",
    content: assistantContent,
    model: input.model || null,
    mode: input.mode || "agent",
    attachments: null,
    agentRun: input.agentRun ? JSON.stringify(input.agentRun) : null,
    usage: input.usage ? JSON.stringify(input.usage) : null,
    liveMetadata: null,
    citations: null,
    // createdAt is stored in whole seconds; a reply to an existing user message
    // must still sort after it.
    createdAt: existingUserOnly
      ? new Date(Math.max(now.getTime(), existingUserOnly.createdAt.getTime() + 1000))
      : new Date(now.getTime() + 1),
  });
  await ftsUpsert(assistantMessageId, input.conversationId, assistantContent);

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
