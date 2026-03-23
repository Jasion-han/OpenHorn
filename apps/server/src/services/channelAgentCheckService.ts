import { getChannelRuntimeCredentialsById } from "./channelService";
import { runClaudeAgentSdk } from "./agentSdk";

export type AgentCheckResult = { success: true } | { success: false; error: string };

const AGENT_SDK_PROBE_TIMEOUT_MS = 12_000;
const AGENT_SDK_PROBE_PROMPT = "Do not use any tools. Reply with exactly OK.";
const AGENT_SDK_INCOMPATIBLE_ERROR =
  "该渠道支持普通聊天接口，但不兼容 Claude Agent SDK，无法用于 Agent 模式。它仍可用于普通聊天。";

export async function evaluateAgentProbe(
  events: AsyncIterable<{ type?: string; content?: string }>,
): Promise<AgentCheckResult> {
  for await (const event of events) {
    if (event?.type === "text" && typeof event.content === "string" && event.content.trim()) {
      return { success: true };
    }
    if (event?.type === "error") {
      return { success: false, error: event.content || "Agent probe failed" };
    }
    if (event?.type === "done") {
      break;
    }
  }

  return { success: false, error: "未获得任何输出，当前渠道可能不兼容 Agent 运行。" };
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
      return result;
    }
    const probeError = (result as { success: false; error: string }).error;

    return {
      success: false,
      error:
        probeError === "未获得任何输出，当前渠道可能不兼容 Agent 运行。"
          ? AGENT_SDK_INCOMPATIBLE_ERROR
          : probeError,
    };
  } catch (error) {
    if (abortController.signal.aborted && abortController.signal.reason === "compatibility_timeout") {
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

export async function checkChannelAgentCompatibility(
  userId: string,
  channelId: string,
  modelId: string,
  options?: {
    sdkTimeoutMs?: number;
  },
): Promise<AgentCheckResult> {
  const trimmedModelId = modelId.trim();
  if (!trimmedModelId) {
    return { success: false, error: "modelId is required" };
  }

  const { channel, apiKey } = await getChannelRuntimeCredentialsById(userId, channelId, {
    runtime: "agent_sdk",
  });
  const baseUrl = channel.baseUrl;
  if (!baseUrl) {
    return { success: false, error: "Base URL is required" };
  }

  return probeClaudeAgentSdkCompatibility({
    apiKey,
    modelId: trimmedModelId,
    baseUrl,
    timeoutMs: options?.sdkTimeoutMs,
  });
}
