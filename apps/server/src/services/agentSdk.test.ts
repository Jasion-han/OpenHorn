import { expect, mock, test } from "bun:test";
import { convertSdkEvent } from "./agentSdk";

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
