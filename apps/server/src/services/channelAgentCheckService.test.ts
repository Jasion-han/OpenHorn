import { expect, mock, test } from "bun:test";

async function* gen(...events: Array<{ type?: string; content?: string }>) {
  for (const e of events) {
    yield e;
  }
}

async function loadChannelAgentCheckService(suffix: string) {
  return import(`./channelAgentCheckService?${suffix}=${crypto.randomUUID()}`);
}

test("evaluateAgentProbe: success when first text arrives", async () => {
  const { evaluateAgentProbe } = await loadChannelAgentCheckService("evaluate-success");
  const result = await evaluateAgentProbe(
    gen({ type: "meta" }, { type: "text", content: "OK" }, { type: "done" }),
  );
  expect(result).toEqual({ success: true });
});

test("evaluateAgentProbe: fail when error arrives", async () => {
  const { evaluateAgentProbe } = await loadChannelAgentCheckService("evaluate-error");
  const result = await evaluateAgentProbe(
    gen({ type: "meta" }, { type: "error", content: "boom" }),
  );
  expect(result).toEqual({ success: false, error: "boom" });
});

test("evaluateAgentProbe: fail when done without output", async () => {
  const { evaluateAgentProbe } = await loadChannelAgentCheckService("evaluate-empty");
  const result = await evaluateAgentProbe(gen({ type: "meta" }, { type: "done" }));
  expect(result.success).toBe(false);
});

test("probeClaudeAgentSdkCompatibility: marks init-only timeout as incompatible", async () => {
  mock.module("./agentSdk", () => ({
    runClaudeAgentSdk: async function* () {
      yield { type: "meta" };
      await new Promise((resolve) => setTimeout(resolve, 30));
    },
  }));

  try {
    const { probeClaudeAgentSdkCompatibility: probe } =
      await loadChannelAgentCheckService("timeout");
    const result = await probe({
      apiKey: "test-key",
      modelId: "claude-sonnet-4-6",
      baseUrl: "https://relay.example.com",
      timeoutMs: 10,
    });
    expect(result).toEqual({
      success: false,
      error:
        "该渠道支持普通聊天接口，但不兼容 Claude Agent SDK，无法用于 Agent 模式。它仍可用于普通聊天。",
    });
  } finally {
    mock.restore();
  }
});

test("probeClaudeAgentSdkCompatibility: succeeds when sdk emits text", async () => {
  mock.module("./agentSdk", () => ({
    runClaudeAgentSdk: async function* () {
      yield { type: "meta" };
      yield { type: "text", content: "OK" };
      yield { type: "done" };
    },
  }));

  try {
    const { probeClaudeAgentSdkCompatibility: probe } =
      await loadChannelAgentCheckService("success");
    const result = await probe({
      apiKey: "test-key",
      modelId: "claude-sonnet-4-6",
      baseUrl: "https://relay.example.com",
      timeoutMs: 10,
    });
    expect(result).toEqual({ success: true });
  } finally {
    mock.restore();
  }
});
