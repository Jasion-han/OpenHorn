import type { ApiChannel } from './api';
import type { Conversation } from '@/stores/chatStore';
import { getGlobalDefaultChannel } from './default-channel';

export type EffectiveModelResult =
  | {
      ok: true;
      channelId: string;
      modelId: string;
      label: string;
      source: 'conversation' | 'global';
    }
  | {
      ok: false;
      scope: 'conversation' | 'global';
      reason: string;
    };

export function getEffectiveModelForConversation(
  channels: ApiChannel[],
  conversation: Conversation | null
): EffectiveModelResult {
  const hasConversationOverride = Boolean(conversation?.channelId || conversation?.modelId);
  if (conversation?.channelId && conversation.modelId) {
    const channel = channels.find((c) => c.id === conversation.channelId);
    if (!channel) {
      return { ok: false, scope: 'conversation', reason: '该对话选择的渠道不存在或已被删除，请重新选择模型。' };
    }
    if (!channel.enabled) {
      return { ok: false, scope: 'conversation', reason: '该对话选择的渠道已被禁用，请重新选择模型。' };
    }
    const model = channel.models.find((m) => m.modelId === conversation.modelId);
    if (!model) {
      return { ok: false, scope: 'conversation', reason: '该对话选择的模型不存在或已被移除，请重新选择模型。' };
    }
    if (!model.enabled) {
      return { ok: false, scope: 'conversation', reason: '该对话选择的模型已被禁用，请重新选择模型。' };
    }
    return {
      ok: true,
      channelId: channel.id,
      modelId: model.modelId,
      label: `${channel.provider} · ${model.modelId}`,
      source: 'conversation',
    };
  }

  const def = getGlobalDefaultChannel(channels);
  if (!def) {
    // If user explicitly chose a model for this conversation but it's invalid, do not fall back.
    if (hasConversationOverride) {
      return { ok: false, scope: 'conversation', reason: '该对话的模型设置不完整或不可用，请重新选择模型。' };
    }
    return { ok: false, scope: 'global', reason: '未配置可用的默认渠道/默认模型，请先在设置里完成配置。' };
  }

  return {
    ok: true,
    channelId: def.channelId,
    modelId: def.modelId,
    label: def.label,
    source: 'global',
  };
}
