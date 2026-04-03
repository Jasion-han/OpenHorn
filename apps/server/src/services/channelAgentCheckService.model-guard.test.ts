import { expect, mock, test } from "bun:test";

test("checkChannelAgentCompatibility probes the provided model without name heuristics", async () => {
  mock.module("./agentSdk", () => ({
    runClaudeAgentSdk: async function* () {
      yield { type: "tool_start", toolName: "Bash" };
      yield { type: "text", content: "AGENT_TOOL_OK" };
      yield { type: "done" };
    },
  }));

  try {
    const { probeClaudeAgentSdkCompatibility } = await import(
      `./channelAgentCheckService?model-guard=${crypto.randomUUID()}`
    );
    const result = await probeClaudeAgentSdkCompatibility({
      apiKey: "test-key",
      modelId: "gpt-5.4",
      baseUrl: "https://relay.example.com",
      timeoutMs: 10,
    });

    expect(result).toEqual({ success: true, mode: "claude_sdk" });
  } finally {
    mock.restore();
  }
});
