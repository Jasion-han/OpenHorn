import { attachments, conversations, messages } from "db";
import { and, asc, eq, inArray } from "drizzle-orm";
import { type ChatContentPart, type ChatMessage, createAdapter } from "../agent-adapters";
import { db } from "../db";
import { generateId } from "../utils";
import { createSseStream } from "../utils/sse";
import { runAgentWithConfig } from "./agentService";
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
  status: "completed" | "failed" | "cancelled" | "partial";
  summary: string;
  error?: string;
  steps: AgentRunStep[];
};

type LiveStatusPayload = {
  type: "live_status";
  status: "live" | "offline";
  route: "local" | "structured_live" | "web_search" | "research" | "direct_model";
  label: string;
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

      const { responseContent: assistantContent, agentRun } = await runAgentAndStream({
        send,
        config: {
          userId,
          prompt: input.content,
          attachmentIds: input.attachments || [],
          channelId: conversation.channelId || null,
          modelId: conversation.modelId || null,
          globalSystemPrompt: baseSystemPrompt || undefined,
          liveSystemContext: liveContext.systemContext,
          abortController: _ctx.abortController,
        },
      });

      await db
        .update(messages)
        .set({
          content: assistantContent || agentRun.error || "",
          model: conversation.modelId || null,
          mode: "agent",
          agentRun: JSON.stringify(agentRun),
          liveMetadata: serializeLiveMetadata(liveContext),
          citations: serializeCitations(liveContext.citations),
        })
        .where(eq(messages.id, assistantMessageId));

      await db
        .update(conversations)
        .set({
          updatedAt: new Date(),
          lastMode: "agent",
          runStatus: agentRun.status,
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

      const { responseContent, agentRun } = await runAgentAndStream({
        send,
        config: {
          userId,
          prompt: newContent.trim(),
          attachmentIds,
          channelId: conversation.channelId || null,
          modelId: conversation.modelId || null,
          globalSystemPrompt: baseSystemPrompt || undefined,
          liveSystemContext: liveContext.systemContext,
          abortController: _ctx.abortController,
        },
      });

      await db
        .update(messages)
        .set({
          content: responseContent || agentRun.error || "",
          model: conversation.modelId || null,
          mode: "agent",
          workspaceId,
          contextPaths: contextPaths.length > 0 ? JSON.stringify(contextPaths) : null,
          agentRun: JSON.stringify(agentRun),
          liveMetadata: serializeLiveMetadata(liveContext),
          citations: serializeCitations(liveContext.citations),
        })
        .where(eq(messages.id, assistantMessageId));

      await db
        .update(conversations)
        .set({
          updatedAt: new Date(),
          workspaceId,
          lastMode: "agent",
          runStatus: agentRun.status,
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
): Promise<ReadableStream> {
  return createSseStream(async (send, _ctx) => {
    const [assistantMsg] = await db
      .select()
      .from(messages)
      .where(eq(messages.id, assistantMessageId));
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
        prompt: userMsg.content,
        userSettings: settings,
        tavilyEnvKey: process.env.TAVILY_API_KEY ?? null,
        forceWebSearch: Boolean(conversation.forceWebSearch),
        classifier,
      });
      send(buildLiveStatusPayload(liveContext));
      const citationsPayload = buildCitationsPayload(liveContext.citations);
      if (citationsPayload) {
        send(citationsPayload);
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

      const { responseContent, agentRun } = await runAgentAndStream({
        send,
        config: {
          userId,
          prompt: userMsg.content,
          attachmentIds,
          channelId: conversation.channelId || null,
          modelId: conversation.modelId || null,
          globalSystemPrompt: baseSystemPrompt || undefined,
          liveSystemContext: liveContext.systemContext,
          abortController: _ctx.abortController,
        },
      });

      await db
        .update(messages)
        .set({
          content: responseContent || agentRun.error || "",
          model: conversation.modelId || null,
          mode: "agent",
          workspaceId,
          contextPaths: contextPaths.length > 0 ? JSON.stringify(contextPaths) : null,
          agentRun: JSON.stringify(agentRun),
          liveMetadata: serializeLiveMetadata(liveContext),
          citations: serializeCitations(liveContext.citations),
        })
        .where(eq(messages.id, assistantMessageId));

      await db
        .update(conversations)
        .set({
          updatedAt: new Date(),
          workspaceId,
          lastMode: "agent",
          runStatus: agentRun.status,
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
