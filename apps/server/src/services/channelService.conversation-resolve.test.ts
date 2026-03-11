import { test, expect } from 'bun:test';
import { resolveModelIdFromChannelItem } from './channelService';

test('resolveModelIdFromChannelItem returns explicit modelId only when enabled; otherwise returns null; global default is strict', () => {
  const channel: any = {
    id: 'c1',
    enabled: true,
    legacyModel: null,
    models: [
      { modelId: 'm1', enabled: true, isDefault: false },
      { modelId: 'm2', enabled: true, isDefault: true },
    ],
  };

  expect(resolveModelIdFromChannelItem(channel, 'm1')).toBe('m1');
  expect(resolveModelIdFromChannelItem(channel, 'disabled')).toBe(null);
  expect(resolveModelIdFromChannelItem(channel, null)).toBe('m2');
});
