import type { Channel } from "../types/chat";

export interface DefaultChannelInfo {
  channelId: string;
  provider: string;
  modelId: string;
  label: string;
}

export function getGlobalDefaultChannel(channels: Channel[]): DefaultChannelInfo | null {
  const defaultChannel = channels.find((channel) => channel.isDefault && channel.enabled);
  if (!defaultChannel) {
    return null;
  }

  const defaultModel = defaultChannel.models.find((model) => model.isDefault && model.enabled);
  if (!defaultModel) {
    return null;
  }

  return {
    channelId: defaultChannel.id,
    provider: defaultChannel.provider,
    modelId: defaultModel.modelId,
    label: `${defaultChannel.provider} · ${defaultModel.modelId}`,
  };
}
