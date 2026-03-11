import type { ApiChannel } from './api';
import type { Conversation } from '@/stores/chatStore';
import { getGlobalDefaultChannel } from './default-channel';

export function getEffectiveModelForConversation(
  channels: ApiChannel[],
  conversation: Conversation | null
): { channelId: string; modelId: string; label: string; source: 'conversation' | 'global' } | null {
  if (conversation?.channelId && conversation.modelId) {
    const channel = channels.find((c) => c.id === conversation.channelId && c.enabled);
    const model = channel?.models.find((m) => m.modelId === conversation.modelId && m.enabled);
    if (channel && model) {
      return {
        channelId: channel.id,
        modelId: model.modelId,
        label: `${channel.provider} · ${model.modelId}`,
        source: 'conversation',
      };
    }
  }

  const def = getGlobalDefaultChannel(channels);
  if (!def) return null;

  return {
    channelId: def.channelId,
    modelId: def.modelId,
    label: def.label,
    source: 'global',
  };
}

