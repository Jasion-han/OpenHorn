import { afterAll, expect, mock, test } from "bun:test";
// The `import * as` namespace is a LIVE view: once this file's in-test `mock.module(...)` call
// runs, it would reflect the mocked exports. So snapshot it into a plain object at module-eval
// time (before any test runs a mock) to capture the REAL module. `mock.restore()` does NOT
// unregister `mock.module()`, so re-register the real snapshot in afterAll to stop this file's
// mock leaking into later test files.
import * as realAgentSdkNs from "./agentSdk";

const realAgentSdk = { ...realAgentSdkNs };

afterAll(() => {
  mock.module("./agentSdk", () => realAgentSdk);
});

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
