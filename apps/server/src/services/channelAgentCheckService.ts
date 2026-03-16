import { getChannelRuntimeCredentialsById } from './channelService';

export type AgentCheckResult =
  | { success: true }
  | { success: false; error: string };

export async function evaluateAgentProbe(
  events: AsyncIterable<{ type?: string; content?: string }>
): Promise<AgentCheckResult> {
  for await (const event of events) {
    if (event?.type === 'text' && typeof event.content === 'string' && event.content.trim()) {
      return { success: true };
    }
    if (event?.type === 'error') {
      return { success: false, error: event.content || 'Agent probe failed' };
    }
    if (event?.type === 'done') {
      break;
    }
  }

  return { success: false, error: '未获得任何输出，当前渠道可能不兼容 Agent 运行。' };
}

export async function checkChannelAgentCompatibility(
  userId: string,
  channelId: string,
  modelId: string
): Promise<AgentCheckResult> {
  const trimmedModelId = modelId.trim();
  if (!trimmedModelId) {
    return { success: false, error: 'modelId is required' };
  }

  if (!isLikelyClaudeModel(trimmedModelId)) {
    return {
      success: false,
      error: `当前模型 ${trimmedModelId} 不是 Claude 模型。Agent 运行基于 Claude Agent SDK，请切换到 Claude 模型；如果这是 OpenAI 兼容中转，请把 Provider 改为 OpenAI/DeepSeek。`,
    };
  }

  const { channel, apiKey } = await getChannelRuntimeCredentialsById(userId, channelId, { runtime: 'anthropic' });
  const baseUrl = channel.baseUrl;
  if (!baseUrl) {
    return { success: false, error: 'Base URL is required' };
  }

  // Agent SDK requires Anthropic-compatible /v1/messages endpoint.
  // Test by sending a minimal request — a 401/403/400/200 all indicate the endpoint exists.
  // Only network errors or non-Anthropic responses indicate incompatibility.
  try {
    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: trimmedModelId,
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hi' }],
      }),
      signal: AbortSignal.timeout(10000),
    });

    // 401 = invalid key (endpoint exists, Anthropic-compatible) ✓
    // 400 = bad request (endpoint exists, Anthropic-compatible) ✓
    // 200 = success ✓
    // 403 = forbidden but endpoint exists ✓
    // 5xx = server error, likely not compatible
    // 404 = endpoint not found, not Anthropic-compatible
    if (response.status === 404) {
      return {
        success: false,
        error: `该渠道不支持 Anthropic /v1/messages 接口（返回 404），无法用于 Agent。`,
      };
    }

    if (response.status >= 500) {
      const text = await response.text().catch(() => '');
      return {
        success: false,
        error: `渠道服务器错误（${response.status}）：${text || '未知错误'}`,
      };
    }

    return { success: true };
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') {
      return { success: false, error: '连接超时（10s），请检查 Base URL 是否正确。' };
    }
    return {
      success: false,
      error: error instanceof Error ? error.message : '连接失败',
    };
  }
}

function isLikelyClaudeModel(modelId: string) {
  return modelId.trim().toLowerCase().includes('claude');
}
