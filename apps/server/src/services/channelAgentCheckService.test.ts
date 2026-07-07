import { afterAll, expect, mock, test } from "bun:test";
// These `import * as` namespaces are LIVE views: once this file's in-test `mock.module(...)`
// calls run, they would reflect the mocked exports. So snapshot each into a plain object at
// module-eval time (before any test runs a mock) to capture the REAL modules. `mock.restore()`
// does NOT unregister `mock.module()`, so re-register these real snapshots in afterAll to stop
// this file's mocks leaking into later test files.
import * as realAgentAdaptersNs from "../agent-adapters";
import * as realAgentSdkNs from "./agentSdk";
import * as realChannelServiceNs from "./channelService";

const realAgentAdapters = { ...realAgentAdaptersNs };
const realAgentSdk = { ...realAgentSdkNs };
const realChannelService = { ...realChannelServiceNs };

afterAll(() => {
  mock.module("./agentSdk", () => realAgentSdk);
  mock.module("../agent-adapters", () => realAgentAdapters);
  mock.module("./channelService", () => realChannelService);
});

async function* gen(...events: Array<{ type?: string; content?: string; toolName?: string }>) {
  for (const e of events) {
    yield e;
  }
}

async function loadChannelAgentCheckService(suffix: string) {
  return import(`./channelAgentCheckService?${suffix}=${crypto.randomUUID()}`);
}

test("evaluateAgentProbe: success when bash tool runs and marker text arrives", async () => {
  const { evaluateAgentProbe } = await loadChannelAgentCheckService("evaluate-success");
  const result = await evaluateAgentProbe(
    gen(
      { type: "meta" },
      { type: "tool_start", toolName: "Bash" },
      { type: "text", content: "AGENT_TOOL_OK" },
      { type: "done" },
    ),
  );
  expect(result).toEqual({ success: true, mode: "claude_sdk" });
});

test("evaluateAgentProbe: fail when text arrives without bash tool start", async () => {
  const { evaluateAgentProbe } = await loadChannelAgentCheckService("evaluate-text-only");
  const result = await evaluateAgentProbe(
    gen({ type: "meta" }, { type: "text", content: "AGENT_TOOL_OK" }, { type: "done" }),
  );
  expect(result).toEqual({
    success: false,
    error: "未检测到真实 Bash 工具调用，当前渠道可能只支持普通对话，不兼容 Agent 工具执行。",
  });
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

test("probeClaudeAgentSdkCompatibility: succeeds when sdk emits bash tool start and marker text", async () => {
  mock.module("./agentSdk", () => ({
    runClaudeAgentSdk: async function* () {
      yield { type: "meta" };
      yield { type: "tool_start", toolName: "Bash" };
      yield { type: "text", content: "AGENT_TOOL_OK" };
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
    expect(result).toEqual({ success: true, mode: "claude_sdk" });
  } finally {
    mock.restore();
  }
});

test("probeGenericToolCallingCompatibility: succeeds when adapter returns a structured tool call", async () => {
  let receivedToolChoice: unknown = null;
  let callCount = 0;
  mock.module("../agent-adapters", () => ({
    createAdapter: () => ({
      runToolCallingTurn: async (options: { toolChoice?: unknown }) => {
        callCount += 1;
        if (callCount === 1) {
          receivedToolChoice = options.toolChoice;
          return {
            text: "",
            toolCalls: [
              {
                id: "call-1",
                name: "agent_probe",
                input: { marker: "AGENT_TOOL_OK" },
              },
            ],
            finishReason: "tool_calls",
          };
        }
        return {
          text: "AGENT_TOOL_OK",
          toolCalls: [],
          finishReason: "stop",
        };
      },
    }),
    supportsToolCalling: () => true,
  }));

  try {
    const { probeGenericToolCallingCompatibility } =
      await loadChannelAgentCheckService("generic-success");
    const result = await probeGenericToolCallingCompatibility({
      apiKey: "test-key",
      modelId: "gpt-5.4",
      baseUrl: "https://relay.example.com",
      protocol: "openai",
    });
    expect(result).toEqual({ success: true, mode: "generic_tool_calling" });
    expect(receivedToolChoice).toEqual({ type: "tool", name: "agent_probe" });
    expect(callCount).toBe(2);
  } finally {
    mock.restore();
  }
});

test("probeGenericToolCallingCompatibility: retries without forced tool_choice when provider rejects required mode", async () => {
  let callCount = 0;
  const seenToolChoices: unknown[] = [];
  mock.module("../agent-adapters", () => ({
    createAdapter: () => ({
      runToolCallingTurn: async (options: { toolChoice?: unknown }) => {
        callCount += 1;
        seenToolChoices.push(options.toolChoice);
        if (callCount === 1) {
          throw new Error(
            "Provider API error (400): tool_choice does not support being set to required or object in thinking mode",
          );
        }
        if (callCount === 2) {
          return {
            text: "",
            toolCalls: [
              {
                id: "call-1",
                name: "agent_probe",
                input: { marker: "AGENT_TOOL_OK" },
              },
            ],
            finishReason: "tool_use",
          };
        }
        return {
          text: "AGENT_TOOL_OK",
          toolCalls: [],
          finishReason: "stop",
        };
      },
    }),
    supportsToolCalling: () => true,
  }));

  try {
    const { probeGenericToolCallingCompatibility } = await loadChannelAgentCheckService(
      "generic-tool-choice-fallback",
    );
    const result = await probeGenericToolCallingCompatibility({
      apiKey: "test-key",
      modelId: "qwen3.5-plus",
      baseUrl: "https://relay.example.com",
      protocol: "anthropic",
    });
    expect(result).toEqual({ success: true, mode: "generic_tool_calling" });
    expect(seenToolChoices).toEqual([{ type: "tool", name: "agent_probe" }, undefined, undefined]);
  } finally {
    mock.restore();
  }
});

test("probeGenericToolCallingCompatibility: retries once after a transient timeout", async () => {
  let callCount = 0;
  mock.module("../agent-adapters", () => ({
    createAdapter: () => ({
      runToolCallingTurn: async () => {
        callCount += 1;
        if (callCount === 1) {
          throw new Error("模型响应超时（20s）已停止。");
        }
        if (callCount === 2) {
          return {
            text: "",
            toolCalls: [
              {
                id: "call-1",
                name: "agent_probe",
                input: { marker: "AGENT_TOOL_OK" },
              },
            ],
            finishReason: "tool_use",
          };
        }
        return {
          text: "AGENT_TOOL_OK",
          toolCalls: [],
          finishReason: "stop",
        };
      },
    }),
    supportsToolCalling: () => true,
  }));

  try {
    const { probeGenericToolCallingCompatibility } =
      await loadChannelAgentCheckService("generic-timeout-retry");
    const result = await probeGenericToolCallingCompatibility({
      apiKey: "test-key",
      modelId: "qwen3.5-plus",
      baseUrl: "https://relay.example.com",
      protocol: "anthropic",
    });
    expect(result).toEqual({ success: true, mode: "generic_tool_calling" });
    expect(callCount).toBe(3);
  } finally {
    mock.restore();
  }
});

test("probeGenericToolCallingCompatibility: fails when no structured tool call is returned", async () => {
  mock.module("../agent-adapters", () => ({
    createAdapter: () => ({
      runToolCallingTurn: async () => ({
        text: "I cannot use tools.",
        toolCalls: [],
        finishReason: "stop",
      }),
    }),
    supportsToolCalling: () => true,
  }));

  try {
    const { probeGenericToolCallingCompatibility } =
      await loadChannelAgentCheckService("generic-fail");
    const result = await probeGenericToolCallingCompatibility({
      apiKey: "test-key",
      modelId: "gpt-5.4",
      baseUrl: "https://relay.example.com",
      protocol: "openai",
    });
    expect(result).toEqual({
      success: false,
      error:
        "该渠道支持普通聊天接口，但不兼容当前 Agent 工具运行协议，无法用于 Agent 模式。它仍可用于普通聊天。",
    });
  } finally {
    mock.restore();
  }
});

test("probeGenericToolCallingCompatibility: fails when follow-up turn does not produce final text", async () => {
  let callCount = 0;
  mock.module("../agent-adapters", () => ({
    createAdapter: () => ({
      runToolCallingTurn: async () => {
        callCount += 1;
        if (callCount === 1) {
          return {
            text: "",
            toolCalls: [{ id: "call-1", name: "agent_probe", input: { marker: "AGENT_TOOL_OK" } }],
            finishReason: "tool_use",
          };
        }
        return {
          text: "",
          toolCalls: [],
          finishReason: "stop",
        };
      },
    }),
    supportsToolCalling: () => true,
  }));

  try {
    const { probeGenericToolCallingCompatibility } =
      await loadChannelAgentCheckService("generic-follow-up-fail");
    const result = await probeGenericToolCallingCompatibility({
      apiKey: "test-key",
      modelId: "gpt-5.4",
      baseUrl: "https://relay.example.com",
      protocol: "openai",
    });
    expect(result).toEqual({
      success: false,
      error:
        "该渠道支持普通聊天接口，但不兼容当前 Agent 工具运行协议，无法用于 Agent 模式。它仍可用于普通聊天。",
    });
  } finally {
    mock.restore();
  }
});

test("checkChannelAgentCompatibility: falls back to generic tool calling for anthropic protocol", async () => {
  mock.module("./channelService", () => ({
    getChannels: async () => [],
    getChannelRuntimeCredentialsById: async () => ({
      channel: { id: "channel-1", baseUrl: "https://relay.example.com", protocol: "anthropic" },
      apiKey: "test-key",
    }),
  }));
  mock.module("./agentSdk", () => ({
    runClaudeAgentSdk: async function* () {
      yield {
        type: "error",
        content:
          "该渠道支持普通聊天接口，但不兼容 Claude Agent SDK，无法用于 Agent 模式。它仍可用于普通聊天。",
      };
    },
  }));
  mock.module("../agent-adapters", () => ({
    createAdapter: () => ({
      runToolCallingTurn: (() => {
        let callCount = 0;
        return async () => {
          callCount += 1;
          if (callCount === 1) {
            return {
              text: "",
              toolCalls: [
                { id: "call-1", name: "agent_probe", input: { marker: "AGENT_TOOL_OK" } },
              ],
              finishReason: "tool_use",
            };
          }
          return {
            text: "AGENT_TOOL_OK",
            toolCalls: [],
            finishReason: "stop",
          };
        };
      })(),
    }),
    supportsToolCalling: () => true,
  }));

  try {
    const { checkChannelAgentCompatibility } =
      await loadChannelAgentCheckService("anthropic-fallback");
    const result = await checkChannelAgentCompatibility("user-1", "channel-1", "claude-test");
    expect(result).toEqual({ success: true, mode: "generic_tool_calling" });
  } finally {
    mock.restore();
  }
});

test("checkChannelAgentCompatibility returns the real generic fallback error for anthropic protocol", async () => {
  mock.module("./channelService", () => ({
    getChannels: async () => [],
    getChannelRuntimeCredentialsById: async () => ({
      channel: { id: "channel-1", baseUrl: "https://relay.example.com", protocol: "anthropic" },
      apiKey: "test-key",
    }),
  }));
  mock.module("./agentSdk", () => ({
    runClaudeAgentSdk: async function* () {
      yield {
        type: "error",
        content:
          "该渠道支持普通聊天接口，但不兼容 Claude Agent SDK，无法用于 Agent 模式。它仍可用于普通聊天。",
      };
    },
  }));
  mock.module("../agent-adapters", () => ({
    createAdapter: () => ({
      runToolCallingTurn: async () => {
        throw new Error("Provider API error (429): hour allocated quota exceeded.");
      },
    }),
    supportsToolCalling: () => true,
  }));

  try {
    const { checkChannelAgentCompatibility } = await loadChannelAgentCheckService(
      "anthropic-fallback-real-error",
    );
    const result = await checkChannelAgentCompatibility("user-1", "channel-1", "claude-test", {
      bypassCache: true,
    });
    expect(result).toEqual({
      success: false,
      error: "配额不足或触发限流：小时配额已耗尽。",
      errorCode: "quota_exhausted",
      retryable: true,
      rawError: "Provider API error (429): hour allocated quota exceeded.",
    });
  } finally {
    mock.restore();
  }
});

test("checkChannelAgentCompatibility reuses cached runtime result for repeated checks", async () => {
  let probeCalls = 0;

  mock.module("./channelService", () => ({
    getChannels: async () => [],
    getChannelRuntimeCredentialsById: async () => ({
      channel: { id: "channel-1", baseUrl: "https://relay.example.com", protocol: "openai" },
      apiKey: "test-key",
    }),
  }));
  mock.module("../agent-adapters", () => ({
    createAdapter: () => ({
      runToolCallingTurn: (() => {
        let turnCount = 0;
        return async () => {
          turnCount += 1;
          if (turnCount % 2 === 1) {
            probeCalls += 1;
            return {
              text: "",
              toolCalls: [
                { id: "call-1", name: "agent_probe", input: { marker: "AGENT_TOOL_OK" } },
              ],
              finishReason: "tool_use",
            };
          }
          return {
            text: "AGENT_TOOL_OK",
            toolCalls: [],
            finishReason: "stop",
          };
        };
      })(),
    }),
  }));

  try {
    const { checkChannelAgentCompatibility } = await loadChannelAgentCheckService("cache-hit");
    const first = await checkChannelAgentCompatibility("user-1", "channel-1", "gpt-test");
    const second = await checkChannelAgentCompatibility("user-1", "channel-1", "gpt-test");

    expect(first).toEqual({ success: true, mode: "generic_tool_calling" });
    expect(second).toEqual({ success: true, mode: "generic_tool_calling" });
    expect(probeCalls).toBe(1);
  } finally {
    mock.restore();
  }
});

test("checkChannelAgentCompatibility re-checks after the channel apiKey changes", async () => {
  let probeCalls = 0;
  let currentApiKey = "old-key";

  mock.module("./channelService", () => ({
    getChannels: async () => [],
    getChannelRuntimeCredentialsById: async () => ({
      channel: { id: "channel-1", baseUrl: "https://relay.example.com", protocol: "openai" },
      apiKey: currentApiKey,
    }),
  }));
  mock.module("../agent-adapters", () => ({
    createAdapter: () => ({
      runToolCallingTurn: (() => {
        let turnCount = 0;
        return async () => {
          turnCount += 1;
          if (turnCount % 2 === 1) {
            probeCalls += 1;
            return {
              text: "",
              toolCalls: [
                { id: "call-1", name: "agent_probe", input: { marker: "AGENT_TOOL_OK" } },
              ],
              finishReason: "tool_use",
            };
          }
          return {
            text: "AGENT_TOOL_OK",
            toolCalls: [],
            finishReason: "stop",
          };
        };
      })(),
    }),
  }));

  try {
    const { checkChannelAgentCompatibility } =
      await loadChannelAgentCheckService("cache-apikey-change");
    const first = await checkChannelAgentCompatibility("user-1", "channel-1", "gpt-test");
    currentApiKey = "new-key";
    const second = await checkChannelAgentCompatibility("user-1", "channel-1", "gpt-test");

    expect(first).toEqual({ success: true, mode: "generic_tool_calling" });
    expect(second).toEqual({ success: true, mode: "generic_tool_calling" });
    // Different resolved apiKey => different cache key => the stale verdict is not reused.
    expect(probeCalls).toBe(2);
  } finally {
    mock.restore();
  }
});
