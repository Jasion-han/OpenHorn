import { getChannelRuntimeCredentialsById } from "./channelService";
import { probeAnthropicModel } from "./anthropicProbe";

export type AgentCheckResult = { success: true } | { success: false; error: string };

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

export async function checkChannelAgentCompatibility(
  userId: string,
  channelId: string,
  modelId: string,
): Promise<AgentCheckResult> {
  const trimmedModelId = modelId.trim();
  if (!trimmedModelId) {
    return { success: false, error: "modelId is required" };
  }

  const { channel, apiKey } = await getChannelRuntimeCredentialsById(userId, channelId, {
    runtime: "anthropic",
  });
  const baseUrl = channel.baseUrl;
  if (!baseUrl) {
    return { success: false, error: "Base URL is required" };
  }

  const result = await probeAnthropicModel(baseUrl, apiKey, trimmedModelId);
  if (result.success === false) {
    return { success: false, error: result.error };
  }

  return { success: true };
}
