import { getGlobalDefaultChannel } from "./defaultChannel";
import type { Channel, Conversation } from "../types/chat";

export type EffectiveModelResult =
  | {
      ok: true;
      channelId: string;
      provider: string;
      modelId: string;
      modelDisplayName: string;
      label: string;
      source: "conversation" | "global";
    }
  | {
      ok: false;
      scope: "conversation" | "global";
      reason: string;
    };

export function getEffectiveModelForConversation(
  channels: Channel[],
  conversation: Conversation | null,
): EffectiveModelResult {
  const hasConversationOverride = Boolean(conversation?.channelId || conversation?.modelId);
  if (conversation?.channelId && conversation.modelId) {
    const channel = channels.find((item) => item.id === conversation.channelId);
    if (!channel) {
      return {
        ok: false,
        scope: "conversation",
        reason: "该会话选择的渠道不存在或已被删除，请重新选择模型。",
      };
    }
    if (!channel.enabled) {
      return {
        ok: false,
        scope: "conversation",
        reason: "该会话选择的渠道已被禁用，请重新选择模型。",
      };
    }

    const model = channel.models.find((item) => item.modelId === conversation.modelId);
    if (!model) {
      return {
        ok: false,
        scope: "conversation",
        reason: "该会话选择的模型不存在或已被移除，请重新选择模型。",
      };
    }
    if (!model.enabled) {
      return {
        ok: false,
        scope: "conversation",
        reason: "该会话选择的模型已被禁用，请重新选择模型。",
      };
    }

    return {
      ok: true,
      channelId: channel.id,
      provider: channel.provider,
      modelId: model.modelId,
      modelDisplayName: model.displayName || model.modelId,
      label: `${channel.provider} · ${model.displayName || model.modelId}`,
      source: "conversation",
    };
  }

  const fallback = getGlobalDefaultChannel(channels);
  if (!fallback) {
    if (hasConversationOverride) {
      return {
        ok: false,
        scope: "conversation",
        reason: "该会话的模型设置不完整或不可用，请重新选择模型。",
      };
    }

    return {
      ok: false,
      scope: "global",
      reason: "未配置可用的默认渠道或默认模型，请先在设置里完成配置。",
    };
  }

  return {
    ok: true,
    channelId: fallback.channelId,
    provider: fallback.provider,
    modelId: fallback.modelId,
    modelDisplayName: fallback.modelId,
    label: fallback.label,
    source: "global",
  };
}
