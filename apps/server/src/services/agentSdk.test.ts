import { afterAll, expect, mock, test } from "bun:test";
// The `import * as` namespace is a LIVE view: once this file's in-test `mock.module(...)` call
// runs, it would reflect the mocked exports. So snapshot it into a plain object at module-eval
// time (before any test runs a mock) to capture the REAL SDK. `mock.restore()` does NOT
// unregister `mock.module()`, so re-register the real snapshot in afterAll to stop this file's
// mock leaking into later test files.
import * as realClaudeAgentSdkNs from "@anthropic-ai/claude-agent-sdk";
import { convertSdkEvent, mergeAgentTextOutput } from "./agentSdk";

const realClaudeAgentSdk = { ...realClaudeAgentSdkNs };

afterAll(() => {
  mock.module("@anthropic-ai/claude-agent-sdk", () => realClaudeAgentSdk);
});

test("convertSdkEvent: rewrites generic network errors to actionable guidance", () => {
  const result = convertSdkEvent({
    type: "result",
    subtype: "error_during_execution",
    errors: ["network error"],
  });

  expect(result).toEqual({
    type: "error",
    content: "网络错误：当前渠道可能不兼容 Claude Agent SDK。请检查 Base URL、模型和鉴权配置。",
  });
});

test("convertSdkEvent: surfaces auth status errors", () => {
  const result = convertSdkEvent({
    type: "auth_status",
    error: "network error",
  });

  expect(result).toEqual({
    type: "error",
    content: "网络错误：当前渠道可能不兼容 Claude Agent SDK。请检查 Base URL、模型和鉴权配置。",
  });
});

test("convertSdkEvent: maps assistant invalid_request errors", () => {
  const result = convertSdkEvent({
    type: "assistant",
    error: "invalid_request",
    message: { content: [] },
  });

  expect(result).toEqual({
    type: "error",
    content: "请求无效：当前渠道或模型可能不兼容 Claude Agent SDK。",
  });
});

test("convertSdkEvent: unknown sdk lifecycle messages count as meta activity", () => {
  const result = convertSdkEvent({
    type: "rate_limit",
    message: "slow down",
  });

  expect(result).toEqual({
    type: "meta",
  });
});

test("convertSdkEvent: maps result success payload to text output", () => {
  const result = convertSdkEvent({
    type: "result",
    subtype: "success",
    result: "final answer",
  });

  expect(result).toEqual({
    type: "text",
    content: "final answer",
  });
});

test("convertSdkEvent: maps sdk task notifications to thought output", () => {
  const result = convertSdkEvent({
    type: "system",
    subtype: "task_notification",
    summary: "Checking the workspace",
  });

  expect(result).toEqual({
    type: "thought",
    content: "Checking the workspace",
  });
});

test("convertSdkEvent: treats end_turn as a normal completion", () => {
  const result = convertSdkEvent({
    type: "result",
    subtype: "error_during_execution",
    stop_reason: "end_turn",
    result: "final answer",
    errors: [],
  });

  expect(result).toEqual({
    type: "text",
    content: "final answer",
  });
});

test("convertSdkEvent: treats tool_use as meta activity instead of failure", () => {
  const result = convertSdkEvent({
    type: "result",
    subtype: "error_during_execution",
    stop_reason: "tool_use",
    errors: [],
  });

  expect(result).toEqual({
    type: "meta",
  });
});

test("mergeAgentTextOutput: prefers cumulative final result over partial streamed text", () => {
  expect(mergeAgentTextOutput("Hello", "Hello world")).toBe("Hello world");
});

test("mergeAgentTextOutput: avoids duplicating identical final text", () => {
  expect(mergeAgentTextOutput("Hello world", "Hello world")).toBe("Hello world");
});

test("runClaudeAgentSdk emits heartbeat meta events while waiting for the next sdk message", async () => {
  mock.module("@anthropic-ai/claude-agent-sdk", () => ({
    query: () => ({
      async *[Symbol.asyncIterator]() {
        yield { type: "system", subtype: "init" };
        await new Promise((resolve) => setTimeout(resolve, 12));
        yield {
          type: "assistant",
          message: {
            content: [{ type: "text", text: "ready" }],
          },
        };
      },
    }),
  }));

  try {
    const { runClaudeAgentSdk } = await import(`./agentSdk?heartbeat=${crypto.randomUUID()}`);
    const events: Array<{ type: string; content?: string }> = [];

    for await (const event of runClaudeAgentSdk({
      apiKey: "test-key",
      model: "claude-test",
      prompt: "hello",
      heartbeatMs: 5,
    })) {
      events.push(event);
    }

    expect(events.some((event) => event.type === "meta")).toBe(true);
    expect(events).toContainEqual({
      type: "text",
      content: "ready",
    });
    expect(events.at(-1)).toEqual({
      type: "done",
    });
  } finally {
    mock.restore();
  }
});
