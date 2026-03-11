import { test, expect } from 'bun:test';
import { resolveModelIdFromChannelItem } from './channelService';

test('resolveModelIdFromChannelItem prefers explicit modelId when enabled, otherwise falls back to default', () => {
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
  expect(resolveModelIdFromChannelItem(channel, 'disabled')).toBe('m2');
});

