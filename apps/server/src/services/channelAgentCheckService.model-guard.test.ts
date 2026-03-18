import { expect, mock, test } from "bun:test";

test("checkChannelAgentCompatibility probes the provided model without name heuristics", async () => {
  const originalFetch = globalThis.fetch;
  const fetchMock = mock(
    async () => new Response("{}", { status: 200 }),
  ) as unknown as typeof fetch;
  globalThis.fetch = fetchMock;

  mock.module("./channelService", () => ({
    getChannelRuntimeCredentialsById: async () => ({
      channel: { baseUrl: "https://relay.example.com" },
      apiKey: "test-key",
    }),
    getResolvedChannelForConversation: async () => ({
      channel: { id: "channel-1", provider: "anthropic" },
      modelId: "gpt-5.4",
    }),
  }));

  try {
    const { checkChannelAgentCompatibility } = await import("./channelAgentCheckService");
    const result = await checkChannelAgentCompatibility("user-1", "channel-1", "gpt-5.4");

    expect(result).toEqual({ success: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  } finally {
    globalThis.fetch = originalFetch;
    mock.restore();
  }
});
