import { createAdapter } from "../agent-adapters";
import { runClaudeAgentSdk } from "./agentSdk";
import {
  getChannelRuntimeCredentialsById,
  getChannels,
  type ResolvedChannel,
} from "./channelService";
import type { AgentCapabilityMode } from "./genericAgentTypes";
import { classifyProviderError, type ProviderErrorKind } from "./providerErrorSummary";

function adapterSupportsToolCalling(
  adapter: Awaited<ReturnType<typeof createAdapter>>,
): adapter is import("../agent-adapters").ToolCallingAdapter {
  return typeof (adapter as { runToolCallingTurn?: unknown }).runToolCallingTurn === "function";
}

export type AgentCheckResult =
  | { success: true; mode: AgentCapabilityMode }
  | {
      success: false;
      error: string;
      errorCode?: ProviderErrorKind;
      retryable?: boolean;
      rawError?: string;
    };

// The project compiles with `strict: false`, so control-flow narrowing of this discriminated
// union on the boolean `success` discriminant does not reduce the type. Callers guard on
// `success` at runtime, then use this alias to access the failure fields with a precise cast.
type AgentCheckFailure = Extract<AgentCheckResult, { success: false }>;

export type AgentCheckAttempt = {
  channelId: string;
  channelName: string;
  modelId: string;
  success: boolean;
  error?: string;
  errorCode?: ProviderErrorKind;
};

export type AgentRuntimeResolution =
  | {
      success: true;
      resolvedChannel: ResolvedChannel;
      compatibility: Extract<AgentCheckResult, { success: true }>;
      fallbackUsed: boolean;
      attempts: AgentCheckAttempt[];
    }
  | {
      success: false;
      error: string;
      errorCode?: ProviderErrorKind;
      retryable?: boolean;
      rawError?: string;
      attempts: AgentCheckAttempt[];
    };

type CachedAgentCheckEntry = {
  expiresAt: number;
  result: AgentCheckResult;
};

export function getAgentCapabilityModeFromSuccessResult(
  result: { success: true; mode?: AgentCapabilityMode },
  protocol: string | null | undefined,
): AgentCapabilityMode {
  if (result.mode === "claude_sdk" || result.mode === "generic_tool_calling") {
    return result.mode;
  }
  return (protocol || "").trim().toLowerCase() === "openai" ? "generic_tool_calling" : "claude_sdk";
}

const AGENT_SDK_PROBE_TIMEOUT_MS = 20_000;
const GENERIC_TOOL_PROBE_TIMEOUT_MS = 45_000;
const GENERIC_TOOL_PROBE_MAX_ATTEMPTS = 2;
const AGENT_COMPATIBILITY_SUCCESS_TTL_MS = 60 * 60_000;
const AGENT_COMPATIBILITY_FAILURE_TTL_MS = 45_000;
const AGENT_SDK_PROBE_MARKER = "AGENT_TOOL_OK";
const GENERIC_TOOL_PROBE_NAME = "agent_probe";
const AGENT_SDK_PROBE_PROMPT = [
  "Use the Bash tool to run exactly this command: printf 'AGENT_TOOL_OK'",
  "Do not simulate the command output.",
  "After the tool finishes, reply with exactly AGENT_TOOL_OK.",
].join(" ");
const AGENT_SDK_INCOMPATIBLE_ERROR =
  "该渠道支持普通聊天接口，但不兼容 Claude Agent SDK，无法用于 Agent 模式。它仍可用于普通聊天。";
const GENERIC_TOOL_INCOMPATIBLE_ERROR =
  "该渠道支持普通聊天接口，但不兼容当前 Agent 工具运行协议，无法用于 Agent 模式。它仍可用于普通聊天。";

const compatibilityCache = new Map<string, CachedAgentCheckEntry>();
const compatibilityInFlight = new Map<string, Promise<AgentCheckResult>>();

function isCompatibilityPlaceholderError(error: string) {
  return error === AGENT_SDK_INCOMPATIBLE_ERROR || error === GENERIC_TOOL_INCOMPATIBLE_ERROR;
}

function pickAnthropicCompatibilityFailure(
  sdkResult: Extract<AgentCheckResult, { success: false }>,
  genericResult: Extract<AgentCheckResult, { success: false }>,
): Extract<AgentCheckResult, { success: false }> {
  const sdkIsPlaceholder = isCompatibilityPlaceholderError(sdkResult.error);
  const genericIsPlaceholder = isCompatibilityPlaceholderError(genericResult.error);

  if (sdkIsPlaceholder && !genericIsPlaceholder) {
    return genericResult;
  }
  if (!sdkIsPlaceholder && genericIsPlaceholder) {
    return sdkResult;
  }
  return sdkResult;
}

function normalizeAgentCheckFailure(error: string): Extract<AgentCheckResult, { success: false }> {
  const classified = classifyProviderError(error);
  return {
    success: false,
    error: classified.userMessage,
    errorCode: classified.kind,
    retryable: classified.retryable,
    rawError: classified.raw,
  };
}

function getCompatibilityCacheKey(userId: string, channelId: string, modelId: string) {
  return `${userId}:${channelId}:${modelId.trim()}`;
}

function readCompatibilityCache(key: string) {
  const cached = compatibilityCache.get(key);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    compatibilityCache.delete(key);
    return null;
  }
  return cached.result;
}

function writeCompatibilityCache(key: string, result: AgentCheckResult) {
  compatibilityCache.set(key, {
    result,
    expiresAt:
      Date.now() +
      (result.success ? AGENT_COMPATIBILITY_SUCCESS_TTL_MS : AGENT_COMPATIBILITY_FAILURE_TTL_MS),
  });
}

function shouldRetryGenericProbeWithoutForcedToolChoice(error: unknown) {
  const message =
    error instanceof Error ? error.message.toLowerCase() : String(error || "").toLowerCase();
  if (!message.includes("tool_choice")) return false;
  return (
    message.includes("does not support being set to required") ||
    message.includes("does not support being set to required or object") ||
    message.includes("thinking mode")
  );
}

function shouldRetryGenericProbeAfterFailure(error: string) {
  const normalized = error.toLowerCase();
  return (
    normalized.includes("timeout") ||
    normalized.includes("超时") ||
    /provider api error \((429|502|503|504)\)/i.test(error)
  );
}

function buildChannelProbeOrder<
  T extends { id: string; name: string; enabled: boolean; isDefault: boolean },
>(channels: T[], requestedChannelId: string | null) {
  if (requestedChannelId) {
    const requested = channels.find((channel) => channel.id === requestedChannelId);
    return requested ? [requested] : [];
  }

  return channels
    .filter((channel) => channel.enabled)
    .sort((left, right) => {
      if (left.isDefault !== right.isDefault) return left.isDefault ? -1 : 1;
      return left.name.localeCompare(right.name);
    });
}

function buildModelProbeOrder(
  channel: Awaited<ReturnType<typeof getChannels>>[number],
  requestedModelId: string | null,
) {
  const enabledModelIds = channel.models
    .filter((model) => model.enabled)
    .map((model) => model.modelId)
    .filter((modelId) => modelId.trim().length > 0);

  const ordered: string[] = [];
  const push = (modelId: string | null | undefined) => {
    if (!modelId) return;
    const trimmed = modelId.trim();
    if (!trimmed || !enabledModelIds.includes(trimmed) || ordered.includes(trimmed)) return;
    ordered.push(trimmed);
  };

  push(requestedModelId);
  push(
    channel.defaultModelId ||
      channel.models.find((model) => model.isDefault && model.enabled)?.modelId,
  );

  for (const modelId of enabledModelIds) {
    push(modelId);
  }

  return ordered;
}

function hasEnabledModel(
  channel: Awaited<ReturnType<typeof getChannels>>[number],
  modelId: string | null,
) {
  if (!modelId) return false;
  const trimmed = modelId.trim();
  if (!trimmed) return false;
  return channel.models.some((model) => model.enabled && model.modelId === trimmed);
}

export function describeAgentRuntimeSelection(params: {
  resolvedChannel: ResolvedChannel;
  requestedChannelId?: string | null;
  requestedModelId?: string | null;
}) {
  const requestedChannelId = params.requestedChannelId?.trim() || null;
  const requestedModelId = params.requestedModelId?.trim() || null;
  const changedChannel =
    requestedChannelId !== null && requestedChannelId !== params.resolvedChannel.channel.id;
  const changedModel =
    requestedModelId !== null && requestedModelId !== params.resolvedChannel.modelId;

  if (!changedChannel && !changedModel) {
    return `Using ${params.resolvedChannel.modelId}`;
  }

  if (changedChannel) {
    return `Using ${params.resolvedChannel.modelId} via ${params.resolvedChannel.channel.name}`;
  }

  return `Using ${params.resolvedChannel.modelId}`;
}

export async function evaluateAgentProbe(
  events: AsyncIterable<{ type?: string; content?: string; toolName?: string }>,
): Promise<AgentCheckResult> {
  let sawBashTool = false;
  let textOutput = "";

  for await (const event of events) {
    if (event?.type === "tool_start" && event.toolName === "Bash") {
      sawBashTool = true;
      continue;
    }
    if (event?.type === "text" && typeof event.content === "string" && event.content.trim()) {
      textOutput += event.content;
      if (sawBashTool && textOutput.includes(AGENT_SDK_PROBE_MARKER)) {
        return { success: true, mode: "claude_sdk" };
      }
      continue;
    }
    if (event?.type === "error") {
      return { success: false, error: event.content || "Agent probe failed" };
    }
    if (event?.type === "done") {
      break;
    }
  }

  return {
    success: false,
    error: "未检测到真实 Bash 工具调用，当前渠道可能只支持普通对话，不兼容 Agent 工具执行。",
  };
}

export async function probeClaudeAgentSdkCompatibility(params: {
  apiKey: string;
  modelId: string;
  baseUrl: string;
  timeoutMs?: number;
}): Promise<AgentCheckResult> {
  const timeoutMs = params.timeoutMs ?? AGENT_SDK_PROBE_TIMEOUT_MS;
  const abortController = new AbortController();
  const timer = setTimeout(() => {
    if (!abortController.signal.aborted) {
      abortController.abort("compatibility_timeout");
    }
  }, timeoutMs);

  try {
    const result = await evaluateAgentProbe(
      runClaudeAgentSdk({
        apiKey: params.apiKey,
        model: params.modelId,
        baseUrl: params.baseUrl,
        prompt: AGENT_SDK_PROBE_PROMPT,
        abortController,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        maxTurns: 1,
        heartbeatMs: 1_000,
      }),
    );

    if (result.success) {
      return { success: true, mode: "claude_sdk" };
    }
    const probeError = (result as { success: false; error: string }).error;

    return {
      success: false,
      error:
        probeError ===
        "未检测到真实 Bash 工具调用，当前渠道可能只支持普通对话，不兼容 Agent 工具执行。"
          ? AGENT_SDK_INCOMPATIBLE_ERROR
          : probeError,
    };
  } catch (error) {
    if (
      abortController.signal.aborted &&
      abortController.signal.reason === "compatibility_timeout"
    ) {
      return { success: false, error: AGENT_SDK_INCOMPATIBLE_ERROR };
    }

    return {
      success: false,
      error: error instanceof Error ? error.message : "Agent probe failed",
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function probeGenericToolCallingCompatibility(params: {
  apiKey: string;
  modelId: string;
  baseUrl: string;
  protocol: string;
  requestTimeoutMs?: number;
  maxAttempts?: number;
}): Promise<AgentCheckResult> {
  const adapter = createAdapter(params.protocol, params.apiKey, params.baseUrl);
  if (!adapterSupportsToolCalling(adapter)) {
    return { success: false, error: GENERIC_TOOL_INCOMPATIBLE_ERROR };
  }

  const requestTimeoutMs = params.requestTimeoutMs ?? GENERIC_TOOL_PROBE_TIMEOUT_MS;
  const maxAttempts = Math.max(1, params.maxAttempts ?? GENERIC_TOOL_PROBE_MAX_ATTEMPTS);

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const runInitialTurn = async (forceToolChoice: boolean) =>
        adapter.runToolCallingTurn({
          model: params.modelId,
          messages: [
            {
              role: "user",
              content:
                "Call the agent_probe tool exactly once with marker AGENT_TOOL_OK. Do not answer directly. After the tool result arrives, reply with exactly AGENT_TOOL_OK.",
            },
          ],
          tools: [
            {
              name: GENERIC_TOOL_PROBE_NAME,
              description: "Probe tool used to verify structured tool calling support.",
              inputSchema: {
                type: "object",
                properties: {
                  marker: { type: "string" },
                },
                required: ["marker"],
                additionalProperties: false,
              },
            },
          ],
          ...(forceToolChoice
            ? { toolChoice: { type: "tool" as const, name: GENERIC_TOOL_PROBE_NAME } }
            : {}),
          requestTimeoutMs,
        });

      let result;
      try {
        result = await runInitialTurn(true);
      } catch (error) {
        if (!shouldRetryGenericProbeWithoutForcedToolChoice(error)) {
          throw error;
        }
        result = await runInitialTurn(false);
      }

      const matchedCall = result.toolCalls.find(
        (toolCall) =>
          toolCall.name === GENERIC_TOOL_PROBE_NAME &&
          toolCall.input.marker === AGENT_SDK_PROBE_MARKER,
      );
      if (!matchedCall) {
        return { success: false, error: GENERIC_TOOL_INCOMPATIBLE_ERROR };
      }

      const followUp = await adapter.runToolCallingTurn({
        model: params.modelId,
        messages: [
          {
            role: "user",
            content:
              "Call the agent_probe tool exactly once with marker AGENT_TOOL_OK. Do not answer directly. After the tool result arrives, reply with exactly AGENT_TOOL_OK.",
          },
          {
            role: "assistant",
            content: result.text,
            toolCalls: result.toolCalls,
          },
          {
            role: "tool",
            toolCallId: matchedCall.id,
            name: GENERIC_TOOL_PROBE_NAME,
            content: AGENT_SDK_PROBE_MARKER,
          },
        ],
        tools: [
          {
            name: GENERIC_TOOL_PROBE_NAME,
            description: "Probe tool used to verify structured tool calling support.",
            inputSchema: {
              type: "object",
              properties: {
                marker: { type: "string" },
              },
              required: ["marker"],
              additionalProperties: false,
            },
          },
        ],
        requestTimeoutMs,
      });

      if (followUp.toolCalls.length > 0 || !followUp.text.includes(AGENT_SDK_PROBE_MARKER)) {
        return { success: false, error: GENERIC_TOOL_INCOMPATIBLE_ERROR };
      }
      return { success: true, mode: "generic_tool_calling" };
    } catch (error) {
      const message = error instanceof Error ? error.message : GENERIC_TOOL_INCOMPATIBLE_ERROR;
      if (attempt >= maxAttempts - 1 || !shouldRetryGenericProbeAfterFailure(message)) {
        return {
          success: false,
          error: message,
        };
      }
    }
  }

  return { success: false, error: GENERIC_TOOL_INCOMPATIBLE_ERROR };
}

export async function checkChannelAgentCompatibility(
  userId: string,
  channelId: string,
  modelId: string,
  options?: {
    sdkTimeoutMs?: number;
    bypassCache?: boolean;
  },
): Promise<AgentCheckResult> {
  const trimmedModelId = modelId.trim();
  if (!trimmedModelId) {
    return {
      success: false,
      error: "缺少模型标识，请重新选择模型。",
      errorCode: "request_failed",
      retryable: false,
      rawError: "modelId is required",
    };
  }

  const cacheKey = getCompatibilityCacheKey(userId, channelId, trimmedModelId);
  if (!options?.bypassCache) {
    const cached = readCompatibilityCache(cacheKey);
    if (cached) return cached;

    const inFlight = compatibilityInFlight.get(cacheKey);
    if (inFlight) {
      return inFlight;
    }
  }

  const probePromise = (async (): Promise<AgentCheckResult> => {
    const { channel, apiKey, isCliOAuth } = await getChannelRuntimeCredentialsById(
      userId,
      channelId,
      {
        runtime: "agent_sdk",
      },
    );
    const baseUrl = channel.baseUrl;
    if (!baseUrl) {
      return {
        success: false,
        error: "缺少 Base URL，请检查渠道配置。",
        errorCode: "request_failed",
        retryable: false,
        rawError: "Base URL is required",
      };
    }

    const protocol = (channel.protocol || "").trim().toLowerCase();
    if (protocol === "openai") {
      if (isCliOAuth) {
        return { success: true, mode: "generic_tool_calling" as AgentCapabilityMode };
      }
      const result = await probeGenericToolCallingCompatibility({
        apiKey,
        modelId: trimmedModelId,
        baseUrl,
        protocol,
      });
      if (result.success) {
        return result;
      }
      return normalizeAgentCheckFailure((result as AgentCheckFailure).error);
    }

    if (protocol === "anthropic") {
      if (!apiKey || isCliOAuth) {
        return { success: true, mode: "claude_sdk" as AgentCapabilityMode };
      }
      const claudeSdkResult = await probeClaudeAgentSdkCompatibility({
        apiKey,
        modelId: trimmedModelId,
        baseUrl,
        timeoutMs: options?.sdkTimeoutMs,
      });
      if (claudeSdkResult.success) {
        return claudeSdkResult;
      }
      // Guarded as a failure above; cast to the failure variant (see AgentCheckFailure note).
      const claudeSdkFailure = claudeSdkResult as AgentCheckFailure;

      const genericResult = await probeGenericToolCallingCompatibility({
        apiKey,
        modelId: trimmedModelId,
        baseUrl,
        protocol,
      });
      if (genericResult.success) {
        return genericResult;
      }
      const genericFailure = genericResult as AgentCheckFailure;

      return normalizeAgentCheckFailure(
        pickAnthropicCompatibilityFailure(claudeSdkFailure, genericFailure).error,
      );
    }

    const result = await probeClaudeAgentSdkCompatibility({
      apiKey,
      modelId: trimmedModelId,
      baseUrl,
      timeoutMs: options?.sdkTimeoutMs,
    });
    if (result.success) {
      return result;
    }
    return normalizeAgentCheckFailure((result as AgentCheckFailure).error);
  })();

  if (options?.bypassCache) {
    return probePromise;
  }

  compatibilityInFlight.set(cacheKey, probePromise);
  try {
    const result = await probePromise;
    writeCompatibilityCache(cacheKey, result);
    return result;
  } finally {
    compatibilityInFlight.delete(cacheKey);
  }
}

export async function resolveAgentRuntime(params: {
  userId: string;
  requestedChannelId?: string | null;
  requestedModelId?: string | null;
  sdkTimeoutMs?: number;
  bypassCache?: boolean;
}): Promise<AgentRuntimeResolution> {
  const channels = await getChannels(params.userId);
  const requestedChannelId = params.requestedChannelId?.trim() || null;
  const requestedModelId = params.requestedModelId?.trim() || null;
  const channelOrder = buildChannelProbeOrder(channels, requestedChannelId).filter(
    (channel) => channel.enabled && channel.hasApiKey,
  );

  if (channelOrder.length === 0) {
    return {
      success: false,
      error: "未配置可用的默认渠道/默认模型。请先在设置中完成配置。",
      errorCode: "request_failed",
      retryable: false,
      rawError: "No default channel or model is configured. Configure one in Settings first.",
      attempts: [],
    };
  }

  const attempts: AgentCheckAttempt[] = [];
  let lastError = "未找到可用于 Agent 模式的模型。";
  let lastFailure: Extract<AgentCheckResult, { success: false }> | null = null;

  for (const channel of channelOrder) {
    const runtimeChannel = await getChannelRuntimeCredentialsById(params.userId, channel.id, {
      runtime: "agent_sdk",
    }).catch(() => null);
    if (!runtimeChannel) {
      continue;
    }

    const isRequestedChannel = channel.id === requestedChannelId;
    const strictRequestedModel = isRequestedChannel && requestedModelId !== null;
    if (strictRequestedModel && !hasEnabledModel(channel, requestedModelId)) {
      return {
        success: false,
        error: "当前会话选择的模型不存在或已被禁用，请重新选择模型。",
        errorCode: "model_not_found",
        retryable: false,
        rawError: requestedModelId,
        attempts,
      };
    }

    const modelOrder = strictRequestedModel
      ? [requestedModelId!]
      : buildModelProbeOrder(channel, isRequestedChannel ? requestedModelId : null);
    if (modelOrder.length === 0) {
      continue;
    }

    for (const modelId of modelOrder) {
      const compatibility = await checkChannelAgentCompatibility(
        params.userId,
        channel.id,
        modelId,
        {
          sdkTimeoutMs: params.sdkTimeoutMs,
          bypassCache: params.bypassCache,
        },
      );
      if (compatibility.success) {
        attempts.push({
          channelId: channel.id,
          channelName: channel.name,
          modelId,
          success: true,
        });
        return {
          success: true,
          resolvedChannel: {
            ...runtimeChannel,
            modelId,
          },
          compatibility,
          fallbackUsed:
            (requestedChannelId !== null && requestedChannelId !== channel.id) ||
            (requestedModelId !== null && requestedModelId !== modelId),
          attempts,
        };
      }

      attempts.push({
        channelId: channel.id,
        channelName: channel.name,
        modelId,
        success: false,
        error: (compatibility as Extract<AgentCheckResult, { success: false }>).error,
        errorCode: (compatibility as Extract<AgentCheckResult, { success: false }>).errorCode,
      });
      lastFailure = compatibility as Extract<AgentCheckResult, { success: false }>;
      lastError = lastFailure.error;
    }
  }

  return {
    success: false,
    error: lastError,
    errorCode: lastFailure?.errorCode,
    retryable: lastFailure?.retryable,
    rawError: lastFailure?.rawError,
    attempts,
  };
}
