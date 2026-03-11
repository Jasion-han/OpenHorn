import type { ApiChannel } from './api';

export interface DefaultChannelInfo {
  provider: string;
  modelId: string;
  label: string;
}

export function getGlobalDefaultChannel(channels: ApiChannel[]): DefaultChannelInfo | null {
  const defaultChannel = channels.find((channel) => channel.isDefault && channel.enabled);
  if (!defaultChannel) {
    return null;
  }

  const defaultModel = defaultChannel.models.find((model) => model.isDefault && model.enabled)
    || defaultChannel.models.find((model) => model.enabled);

  if (!defaultModel) {
    return null;
  }

  return {
    provider: defaultChannel.provider,
    modelId: defaultModel.modelId,
    label: `${defaultChannel.provider} · ${defaultModel.modelId}`,
  };
}
