import type { AgentEvent } from './agentService';

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

