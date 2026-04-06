import type { CanUseTool, PermissionMode, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { agentEvents, agentSessions, attachments, conversations } from "db";
import { and, desc, eq } from "drizzle-orm";
import { createAdapter } from "../agent-adapters";
import { db } from "../db";
import { generateId } from "../utils";
import { runClaudeAgentSdk } from "./agentSdk";
import {
  resolveAgentRuntime,
} from "./channelAgentCheckService";
import { resolveAgentWorkingDirectory } from "./agentWorkspace";
import { buildAttachmentPayloadFromIds } from "./attachmentService";
import {
  AGENT_FIRST_OUTPUT_TIMEOUT_MS,
  AGENT_IDLE_TIMEOUT_MS,
  AGENT_TOTAL_TIMEOUT_MS,
  formatTimeoutSeconds,
} from "./agentStreamTimeouts";
import { getResolvedChannelForConversation, getResolvedChannelForUser } from "./channelService";
import { buildLiveContext, type LiveContextResult } from "./liveCapabilities";
import { classifyLiveRouteWithModel } from "./liveRouteClassifier";
import { loadEnabledMcpServersForUser } from "./mcpLoader";
import { mergeSystemPromptParts, RESPONSE_STYLE_GUARDRAILS } from "./responseStyle";
import { TAVILY_API_KEY_SETTING, TAVILY_ENABLED_SETTING } from "./searchService";
import { getSettingValues } from "./settingsService";
import { runGenericAgentRuntime } from "./genericAgentRuntime";
import type { AgentCapabilityMode } from "./genericAgentTypes";

function adapterSupportsToolCalling(
  adapter: Awaited<ReturnType<typeof createAdapter>>,
): adapter is import("../agent-adapters").ToolCallingAdapter {
  return typeof (adapter as { runToolCallingTurn?: unknown }).runToolCallingTurn === "function";
}

async function saveAgentEvent(sessionId: string, event: AgentEvent): Promise<void> {
  if (
    event.type === "meta" ||
    event.type === "done" ||
    event.type === "text_delta" ||
    event.type === "text_reset"
  ) {
    return;
  }
  try {
    await db.insert(agentEvents).values({
      id: generateId(),
      sessionId,
      type: event.type,
      content: event.content ?? null,
      toolName: event.toolName ?? null,
      toolInput: event.toolInput !== undefined ? JSON.stringify(event.toolInput) : null,
      createdAt: new Date(),
    });
  } catch (e) {
    console.error("[saveAgentEvent] failed:", e);
  }
}

export async function getAgentEvents(userId: string, sessionId: string): Promise<AgentEvent[]> {
  const session = await getAgentSessionById(userId, sessionId);
  if (!session) return [];
  const rows = await db
    .select()
    .from(agentEvents)
    .where(eq(agentEvents.sessionId, sessionId))
    .orderBy(agentEvents.createdAt);
  return rows.map((row) => ({
    id: row.id,
    type: row.type as AgentEvent["type"],
    content: row.content ?? undefined,
    toolName: row.toolName ?? undefined,
    toolInput: row.toolInput
      ? (() => {
          try {
            return JSON.parse(row.toolInput);
          } catch {
            return row.toolInput;
          }
        })()
      : undefined,
  }));
}

export async function deleteAgentEvent(userId: string, eventId: string): Promise<boolean> {
  const rows = await db
    .select({ id: agentEvents.id })
    .from(agentEvents)
    .innerJoin(agentSessions, eq(agentEvents.sessionId, agentSessions.id))
    .where(and(eq(agentEvents.id, eventId), eq(agentSessions.userId, userId)));
  if (rows.length === 0) return false;
  await db.delete(agentEvents).where(eq(agentEvents.id, eventId));
  return true;
}

export interface CreateAgentSessionInput {
  channelId?: string;
  title: string;
}

export interface AgentEvent {
  type:
    | "user"
    | "meta"
    | "thought"
    | "text_delta"
    | "text_reset"
    | "text"
    | "tool_start"
    | "tool_result"
    | "done"
    | "error";
  [key: string]: unknown;
  content?: string;
  toolName?: string;
  toolInput?: unknown;
}

export interface AgentRuntimeConfig {
  userId: string;
  prompt: string;
  conversationHistory?: Array<{
    role: "user" | "assistant";
    content: string;
  }>;
  attachmentIds?: string[];
  channelId?: string | null;
  modelId?: string | null;
  globalSystemPrompt?: string;
  liveSystemContext?: string;
  permissionMode?: PermissionMode;
  canUseTool?: CanUseTool;
  capabilityMode?: AgentCapabilityMode;
  abortController?: AbortController;
  onEvent?: (event: AgentEvent) => Promise<void> | void;
}

export interface PreparedAgentRuntimeContext {
  channelId: string | null;
  modelId: string | null;
  globalSystemPrompt?: string;
  liveSystemContext?: string;
  liveContext?: LiveContextResult;
}

export async function buildAgentRuntimeContext(params: {
  userId: string;
  prompt: string;
  channelId?: string | null;
  modelId?: string | null;
  conversationId?: string | null;
  forceWebSearch?: boolean | null;
}): Promise<PreparedAgentRuntimeContext> {
  const valuesPromise = getSettingValues(params.userId, [
    "chat.systemPrompt",
    TAVILY_API_KEY_SETTING,
    TAVILY_ENABLED_SETTING,
  ]);
  const forceWebSearchPromise =
    params.forceWebSearch != null || !params.conversationId
      ? Promise.resolve(params.forceWebSearch ?? null)
      : db
          .select({ forceWebSearch: conversations.forceWebSearch })
          .from(conversations)
          .where(and(eq(conversations.id, params.conversationId), eq(conversations.userId, params.userId)))
          .limit(1)
          .then((rows) => rows[0]?.forceWebSearch ?? null);
  const resolvedChannelPromise = getResolvedChannelForConversation(params.userId, {
    channelId: params.channelId ?? null,
    modelId: params.modelId ?? null,
  });
  const [values, forceWebSearch, resolvedChannel] = await Promise.all([
    valuesPromise,
    forceWebSearchPromise,
    resolvedChannelPromise,
  ]);
  const globalSystemPrompt = values["chat.systemPrompt"] || undefined;
  const classifier = resolvedChannel
    ? (inputPrompt: string) =>
        classifyLiveRouteWithModel({
          protocol: resolvedChannel.channel.protocol,
          apiKey: resolvedChannel.apiKey,
          baseUrl: resolvedChannel.channel.baseUrl,
          modelId: resolvedChannel.modelId,
          prompt: inputPrompt,
        })
    : undefined;
  const liveContext = await buildLiveContext({
    prompt: params.prompt,
    userSettings: values,
    tavilyEnvKey: process.env.TAVILY_API_KEY ?? null,
    forceWebSearch: forceWebSearch == null ? true : Boolean(forceWebSearch),
    classifier,
  });

  return {
    channelId: params.channelId ?? resolvedChannel?.channel.id ?? null,
    modelId: params.modelId ?? resolvedChannel?.modelId ?? null,
    globalSystemPrompt,
    liveSystemContext: liveContext.systemContext,
    liveContext,
  };
}

export async function getAgentSessions(userId: string) {
  return db
    .select()
    .from(agentSessions)
    .where(eq(agentSessions.userId, userId))
    .orderBy(desc(agentSessions.updatedAt));
}

export async function getAgentSessionById(userId: string, sessionId: string) {
  const result = await db
    .select()
    .from(agentSessions)
    .where(and(eq(agentSessions.id, sessionId), eq(agentSessions.userId, userId)))
    .limit(1);
  return result.length > 0 ? result[0] : null;
}

export async function createAgentSession(userId: string, input: CreateAgentSessionInput) {
  const id = generateId();
  const now = new Date();

  await db.insert(agentSessions).values({
    id,
    userId,
    channelId: input.channelId || null,
    title: input.title,
    status: "active",
    createdAt: now,
    updatedAt: now,
  });

  return {
    id,
    userId,
    channelId: input.channelId,
    title: input.title,
    status: "active",
    createdAt: now,
    updatedAt: now,
  };
}

export async function updateAgentSessionStatus(
  userId: string,
  sessionId: string,
  status: "active" | "completed" | "cancelled",
) {
  await db
    .update(agentSessions)
    .set({ status, updatedAt: new Date() })
    .where(and(eq(agentSessions.id, sessionId), eq(agentSessions.userId, userId)));
  return { success: true };
}

export async function renameAgentSession(userId: string, sessionId: string, title: string) {
  const nextTitle = title.trim();
  if (!nextTitle) throw new Error("title is required");

  const result = await db
    .update(agentSessions)
    .set({ title: nextTitle, updatedAt: new Date() })
    .where(and(eq(agentSessions.id, sessionId), eq(agentSessions.userId, userId)));

  const affected = (result as unknown as { rowsAffected?: number }).rowsAffected;
  if (typeof affected === "number" && affected === 0) {
    throw new Error("Session not found");
  }
  return { success: true };
}

export async function updateAgentSessionChannel(
  userId: string,
  sessionId: string,
  channelId: string,
  modelId: string,
) {
  await db
    .update(agentSessions)
    .set({ channelId, modelId, updatedAt: new Date() })
    .where(and(eq(agentSessions.id, sessionId), eq(agentSessions.userId, userId)));
  return { success: true };
}

export async function deleteAgentSession(userId: string, sessionId: string) {
  const session = await getAgentSessionById(userId, sessionId);
  if (!session) {
    throw new Error("Session not found");
  }

  await db.delete(attachments).where(eq(attachments.sessionId, sessionId));
  await db.delete(agentEvents).where(eq(agentEvents.sessionId, sessionId));
  await db
    .delete(agentSessions)
    .where(and(eq(agentSessions.id, sessionId), eq(agentSessions.userId, userId)));
  return { success: true };
}

export async function* runAgentWithConfig(config: AgentRuntimeConfig): AsyncGenerator<AgentEvent> {
  const controller = config.abortController || new AbortController();
  const signal = controller.signal;

  const emit = async (event: AgentEvent) => {
    if (config.onEvent) {
      await config.onEvent(event);
    }
    return event;
  };

  try {
    const runtimeResolution = await (
      config.capabilityMode != null
        ? (() => {
            const requestedChannelId = config.channelId || null;
            return (requestedChannelId
              ? getResolvedChannelForConversation(config.userId, {
                  channelId: requestedChannelId,
                  modelId: config.modelId ?? null,
                })
              : getResolvedChannelForUser(config.userId, null)
            ).then((resolvedChannel) =>
              resolvedChannel
                ? {
                    success: true as const,
                    resolvedChannel,
                    compatibility: { success: true as const, mode: config.capabilityMode as AgentCapabilityMode },
                    fallbackUsed: false,
                    attempts: [],
                  }
                : {
                    success: false as const,
                    error: "未配置可用的默认渠道/默认模型。请先在设置中完成配置。",
                    attempts: [],
                  },
            );
          })()
        : resolveAgentRuntime({
            userId: config.userId,
            requestedChannelId: config.channelId ?? null,
            requestedModelId: config.modelId ?? null,
            bypassCache: true,
          })
    );

    if (runtimeResolution.success === false) {
      yield await emit({ type: "error", content: runtimeResolution.error });
      return;
    }
    const resolvedChannel = runtimeResolution.resolvedChannel;
    const capability = runtimeResolution.compatibility;

    const combinedSystemPrompt =
      mergeSystemPromptParts(
        config.globalSystemPrompt,
        RESPONSE_STYLE_GUARDRAILS,
        config.liveSystemContext,
      ) || undefined;
    const agentWorkingDirectory = resolveAgentWorkingDirectory();

    const attachmentPayload = await buildAttachmentPayloadFromIds(config.attachmentIds || []);
    const attachmentContext = attachmentPayload.textContext;
    const parts: string[] = [];
    if ((config.conversationHistory || []).length > 0) {
      parts.push(
        [
          "Recent conversation context:",
          ...(config.conversationHistory || []).map(
            (message) => `${message.role === "user" ? "User" : "Assistant"}: ${message.content}`,
          ),
        ].join("\n"),
      );
    }
    if (config.prompt.trim()) parts.push(`Task:\n${config.prompt.trim()}`);
    if (attachmentContext?.trim()) parts.push(attachmentContext.trim());

    const finalPrompt = parts.join("\n\n");
    const images = attachmentPayload.images || [];
    const filesMeta = attachmentPayload.files || [];

    const userEventText = (() => {
      const prompt = config.prompt.trim();
      if (prompt) return prompt;
      if (filesMeta.length > 0)
        return `Attachments: ${filesMeta.map((file) => file.fileName).join(", ")}`;
      return "";
    })();

    if (userEventText || filesMeta.length > 0) {
      await emit({
        type: "user",
        content: userEventText,
        toolInput: filesMeta.length > 0 ? { attachments: filesMeta } : undefined,
      });
    }

    const mcpServers = await loadEnabledMcpServersForUser(config.userId);
    const promptForSdk: string | AsyncIterable<SDKUserMessage> =
      images.length > 0
        ? (async function* (): AsyncGenerator<SDKUserMessage> {
            yield {
              type: "user",
              session_id: "conversation-agent",
              parent_tool_use_id: null,
              message: {
                role: "user",
                content: [
                  { type: "text", text: finalPrompt || " " },
                  ...images.map((img) => ({
                    type: "image",
                    source: { type: "base64", media_type: img.fileType, data: img.dataBase64 },
                  })),
                ],
              },
            };
          })()
        : finalPrompt;

    if (capability.mode === "claude_sdk") {
      for await (const event of runClaudeAgentSdk({
        apiKey: resolvedChannel.apiKey,
        model: resolvedChannel.modelId,
        prompt: promptForSdk,
        systemPrompt: combinedSystemPrompt,
        cwd: agentWorkingDirectory,
        baseUrl: resolvedChannel.channel.baseUrl || undefined,
        mcpServers,
        permissionMode: config.permissionMode,
        canUseTool: config.canUseTool,
        abortController: controller,
      })) {
        yield await emit(event);
      }
      return;
    }

    const adapter = createAdapter(
      resolvedChannel.channel.protocol,
      resolvedChannel.apiKey,
      resolvedChannel.channel.baseUrl || undefined,
    );
    if (!adapterSupportsToolCalling(adapter)) {
      yield await emit({
        type: "error",
        content:
          "该渠道支持普通聊天接口，但不兼容当前 Agent 工具运行协议，无法用于 Agent 模式。它仍可用于普通聊天。",
      });
      return;
    }

    for await (const event of runGenericAgentRuntime({
      adapter,
      model: resolvedChannel.modelId,
      prompt: finalPrompt,
      systemPrompt: combinedSystemPrompt,
      cwd: agentWorkingDirectory,
      canUseTool: config.canUseTool,
      signal,
    })) {
      yield await emit(event);
    }
  } catch (error) {
    if (signal.aborted) {
      const reason = "reason" in signal ? (signal as { reason?: unknown }).reason : undefined;
      if (reason === "client_disconnect" || reason === "user") return;
      if (reason === "first_output_timeout") {
        yield await emit({
          type: "error",
          content: `模型长时间无响应（${formatTimeoutSeconds(AGENT_FIRST_OUTPUT_TIMEOUT_MS)}s）已停止。可能当前渠道不兼容 Agent 运行协议，请检查 Base URL、模型和鉴权配置。`,
        });
        return;
      }
      if (reason === "idle_timeout") {
        yield await emit({
          type: "error",
          content: `运行过程中长时间无响应（${formatTimeoutSeconds(AGENT_IDLE_TIMEOUT_MS)}s）已停止。请检查渠道配置或减少任务复杂度后重试。`,
        });
        return;
      }
      if (reason === "total_timeout") {
        yield await emit({
          type: "error",
          content: `运行总时长超时（${formatTimeoutSeconds(AGENT_TOTAL_TIMEOUT_MS)}s）已停止。请检查渠道配置或拆分任务后重试。`,
        });
        return;
      }
    }
    yield await emit({
      type: "error",
      content: error instanceof Error ? error.message : "Agent error",
    });
  }
}

export async function* runAgent(
  userId: string,
  sessionId: string,
  prompt: string,
  attachmentIds: string[] = [],
  abortController?: AbortController,
): AsyncGenerator<AgentEvent> {
  const session = await getAgentSessionById(userId, sessionId);
  if (!session) {
    yield { type: "error", content: "Session not found" };
    return;
  }

  if (session.status !== "active") {
    await db
      .update(agentSessions)
      .set({ status: "active", updatedAt: new Date() })
      .where(and(eq(agentSessions.id, sessionId), eq(agentSessions.userId, userId)));
  }

  const runtimeContext = await buildAgentRuntimeContext({
    userId,
    prompt,
    channelId: session.channelId || null,
    modelId: session.modelId || null,
    conversationId: session.conversationId || null,
  });

  for await (const event of runAgentWithConfig({
    userId,
    prompt,
    attachmentIds,
    channelId: runtimeContext.channelId,
    modelId: runtimeContext.modelId,
    globalSystemPrompt: runtimeContext.globalSystemPrompt,
    liveSystemContext: runtimeContext.liveSystemContext,
    abortController,
    onEvent: (event) => saveAgentEvent(sessionId, event),
  })) {
    yield event;
  }
}
