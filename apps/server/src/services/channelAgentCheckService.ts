import type { AgentEvent } from './agentService';
import { runClaudeAgentSdk } from './agentSdk';
import { getChannelRuntimeCredentialsById } from './channelService';

export type AgentCheckResult =
  | { success: true }
  | { success: false; error: string };

export async function evaluateAgentProbe(events: AsyncIterable<AgentEvent>): Promise<AgentCheckResult> {
  for await (const event of events) {
    if (event.type === 'meta') continue;

    if (event.type === 'error') {
      return { success: false, error: event.content || 'Agent 检查失败' };
    }

    if (event.type === 'text') {
      const content = (event.content || '').trim();
      if (content) {
        return { success: true };
      }
      continue;
    }
  }

  return {
    success: false,
    error: '未获得任何输出（可能仅收到 keepalive/空事件）。可能当前渠道不兼容 Claude Agent SDK。',
  };
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

  // Claude Agent SDK expects an Anthropic-style runtime base URL (no trailing /v1 or /messages).
  const { channel, apiKey } = await getChannelRuntimeCredentialsById(userId, channelId, { runtime: 'anthropic' });
  const baseUrl = channel.baseUrl || undefined;
  if (!baseUrl) {
    return { success: false, error: 'Base URL is required' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort('agent_check_timeout');
  }, 15000);

  try {
    const result = await evaluateAgentProbe(
      runClaudeAgentSdk({
        apiKey,
        model: trimmedModelId,
        prompt: '只回复 OK。',
        baseUrl,
        abortController: controller,
        permissionMode: 'plan',
        maxTurns: 1,
      })
    );

    if (result.success) {
      // Best-effort: stop background work early.
      controller.abort('agent_check_done');
    }

    return result;
  } catch (error) {
    if ((controller.signal as any).aborted) {
      const reason = (controller.signal as any).reason;
      if (reason === 'agent_check_timeout') {
        return {
          success: false,
          error: 'Agent 检查超时（15s 无输出）已停止。可能当前渠道不兼容 Claude Agent SDK。',
        };
      }
    }
    return { success: false, error: error instanceof Error ? error.message : 'Agent 检查失败' };
  } finally {
    clearTimeout(timer);
  }
}
