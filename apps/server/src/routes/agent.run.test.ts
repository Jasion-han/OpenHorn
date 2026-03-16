import { expect, mock, test } from 'bun:test';

test('POST /sessions/:id/run returns compatibility error before starting SSE run', async () => {
  let runAgentCalled = false;
  const originalFetch = globalThis.fetch;

  mock.module('../services/authService', () => ({
    verifyToken: async () => ({ userId: 'user-1' }),
    getUserById: async () => ({ id: 'user-1' }),
  }));

  mock.module('../services/agentService', () => ({
    getAgentSessions: async () => [],
    getAgentSessionById: async () => ({
      id: 'session-1',
      userId: 'user-1',
      title: 'Test',
      status: 'active',
      channelId: 'channel-1',
      modelId: 'gpt-5.4',
    }),
    createAgentSession: async () => ({ id: 'session-1' }),
    updateAgentSessionStatus: async () => ({ success: true }),
    updateAgentSessionChannel: async () => ({ success: true }),
    renameAgentSession: async () => ({ success: true }),
    deleteAgentSession: async () => ({ success: true }),
    getAgentEvents: async () => ({ events: [] }),
    deleteAgentEvent: async () => true,
    runAgent: async function* () {
      runAgentCalled = true;
      yield { type: 'text', content: 'should not run' };
    },
  }));

  mock.module('../services/channelService', () => ({
    getResolvedChannelForConversation: async () => ({
      channel: { id: 'channel-1', provider: 'anthropic' },
      modelId: 'gpt-5.4',
    }),
    getChannelRuntimeCredentialsById: async () => ({
      channel: { id: 'channel-1', provider: 'anthropic', baseUrl: 'https://relay.example.com' },
      apiKey: 'test-key',
    }),
  }));

  mock.module('../services/autoTitleService', () => ({
    generateAutoTitle: async () => 'Title',
  }));

  globalThis.fetch = mock(async () => new Response('missing', { status: 404 })) as typeof fetch;

  try {
    const { default: agent } = await import('./agent');

    const response = await agent.request('/sessions/session-1/run', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: 'token=test-token',
      },
      body: JSON.stringify({ prompt: 'hello' }),
    });

    expect(response.status).toBe(400);
    expect(await response.text()).toBe(
      '当前模型 gpt-5.4 不是 Claude 模型。Agent 运行基于 Claude Agent SDK，请切换到 Claude 模型；如果这是 OpenAI 兼容中转，请把 Provider 改为 OpenAI/DeepSeek。'
    );
    expect(runAgentCalled).toBe(false);
  } finally {
    globalThis.fetch = originalFetch;
    mock.restore();
  }
});
