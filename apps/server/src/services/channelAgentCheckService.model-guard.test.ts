import { expect, mock, test } from 'bun:test';

test('checkChannelAgentCompatibility: rejects non-claude model ids before probing network', async () => {
  const originalFetch = globalThis.fetch;
  const fetchMock = mock(async () => new Response('{}', { status: 200 })) as typeof fetch;
  globalThis.fetch = fetchMock;

  mock.module('./channelService', () => ({
    getChannelRuntimeCredentialsById: async () => ({
      channel: { baseUrl: 'https://relay.example.com' },
      apiKey: 'test-key',
    }),
  }));

  try {
    const { checkChannelAgentCompatibility } = await import('./channelAgentCheckService');
    const result = await checkChannelAgentCompatibility('user-1', 'channel-1', 'gpt-5.4');

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('不是 Claude 模型');
      expect(result.error).toContain('OpenAI/DeepSeek');
    }
    expect(fetchMock).not.toHaveBeenCalled();
  } finally {
    globalThis.fetch = originalFetch;
    mock.restore();
  }
});
