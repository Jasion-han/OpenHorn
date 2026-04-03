import { expect, test } from "bun:test";
import { AnthropicAdapter, OpenAIAdapter } from "./agent-adapters";

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

function getTestMessages() {
  return [
    {
      role: "user" as const,
      content: "hello",
    },
  ];
}

test("OpenAIAdapter chat aborts slow requests with a timeout", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((_: FetchInput, init?: FetchInit) =>
    new Promise((_, reject) => {
      const signal = init?.signal as AbortSignal | undefined;
      signal?.addEventListener(
        "abort",
        () => reject(signal.reason ?? new Error("aborted")),
        { once: true },
      );
    })) as typeof fetch;

  try {
    const adapter = new OpenAIAdapter("test-key", "https://example.com");
    await expect(
      adapter.chat({
        model: "gpt-test",
        messages: getTestMessages(),
        requestTimeoutMs: 10,
      }),
    ).rejects.toThrow("模型响应超时");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OpenAIAdapter chatStream aborts when streamed output goes idle", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_: FetchInput, init?: FetchInit) => {
    const signal = init?.signal as AbortSignal | undefined;
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(
          encoder.encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'),
        );
        signal?.addEventListener(
          "abort",
          () => controller.error(signal.reason ?? new Error("aborted")),
          { once: true },
        );
      },
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
      },
    });
  }) as typeof fetch;

  try {
    const adapter = new OpenAIAdapter("test-key", "https://example.com");
    const chunks: string[] = [];
    let caught: Error | null = null;

    try {
      for await (const chunk of adapter.chatStream({
        model: "gpt-test",
        messages: getTestMessages(),
        streamFirstTokenTimeoutMs: 50,
        streamIdleTimeoutMs: 10,
        streamTotalTimeoutMs: 50,
      })) {
        chunks.push(chunk);
      }
    } catch (error) {
      caught = error instanceof Error ? error : new Error(String(error));
    }

    expect(chunks).toEqual(["hi"]);
    expect(caught?.message).toContain("模型流式输出空闲超时");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OpenAIAdapter chatStream parses SSE streams that start with comment lines", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(": OPENROUTER PROCESSING\n\n"));
        controller.enqueue(
          encoder.encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'),
        );
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "application/json",
      },
    });
  }) as typeof fetch;

  try {
    const adapter = new OpenAIAdapter("test-key", "https://example.com");
    const chunks: string[] = [];

    for await (const chunk of adapter.chatStream({
      model: "gpt-test",
      messages: getTestMessages(),
      streamFirstTokenTimeoutMs: 50,
      streamIdleTimeoutMs: 50,
      streamTotalTimeoutMs: 50,
    })) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual(["hi"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OpenAIAdapter chatStream aborts when the first streamed chunk never arrives", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_: FetchInput, init?: FetchInit) => {
    const signal = init?.signal as AbortSignal | undefined;
    const stream = new ReadableStream({
      start(controller) {
        signal?.addEventListener(
          "abort",
          () => controller.error(signal.reason ?? new Error("aborted")),
          { once: true },
        );
      },
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
      },
    });
  }) as typeof fetch;

  try {
    const adapter = new OpenAIAdapter("test-key", "https://example.com");

    await expect(async () => {
      for await (const _chunk of adapter.chatStream({
        model: "gpt-test",
        messages: getTestMessages(),
        streamFirstTokenTimeoutMs: 10,
        streamIdleTimeoutMs: 50,
        streamTotalTimeoutMs: 50,
      })) {
        // no-op
      }
    }).toThrow("模型首个响应超时");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OpenAIAdapter runToolCallingTurn parses structured tool calls", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              content: "",
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: {
                    name: "bash",
                    arguments: "{\"command\":\"pwd\"}",
                  },
                },
              ],
            },
          },
        ],
      }),
      {
        headers: {
          "Content-Type": "application/json",
        },
      },
    )) as typeof fetch;

  try {
    const adapter = new OpenAIAdapter("test-key", "https://example.com");
    const result = await adapter.runToolCallingTurn({
      model: "gpt-test",
      messages: [{ role: "user", content: "list current directory" }],
      tools: [
        {
          name: "bash",
          description: "Run a shell command",
          inputSchema: {
            type: "object",
            properties: { command: { type: "string" } },
            required: ["command"],
          },
        },
      ],
    });

    expect(result.toolCalls).toEqual([{ id: "call_1", name: "bash", input: { command: "pwd" } }]);
    expect(result.text).toBe("");
    expect(result.finishReason).toBe("tool_calls");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OpenAIAdapter runToolCallingTurn returns final text when no tool call exists", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        choices: [
          {
            finish_reason: "stop",
            message: {
              role: "assistant",
              content: "done",
            },
          },
        ],
      }),
      {
        headers: {
          "Content-Type": "application/json",
        },
      },
    )) as typeof fetch;

  try {
    const adapter = new OpenAIAdapter("test-key", "https://example.com");
    const result = await adapter.runToolCallingTurn({
      model: "gpt-test",
      messages: [{ role: "user", content: "hello" }],
      tools: [],
    });

    expect(result.toolCalls).toEqual([]);
    expect(result.text).toBe("done");
    expect(result.finishReason).toBe("stop");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("AnthropicAdapter runToolCallingTurn parses tool_use blocks", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        stop_reason: "tool_use",
        content: [
          {
            type: "tool_use",
            id: "toolu_1",
            name: "bash",
            input: { command: "pwd" },
          },
        ],
      }),
      {
        headers: {
          "Content-Type": "application/json",
        },
      },
    )) as typeof fetch;

  try {
    const adapter = new AnthropicAdapter("test-key", "https://example.com");
    const result = await adapter.runToolCallingTurn({
      model: "claude-test",
      messages: [{ role: "user", content: "run pwd" }],
      tools: [
        {
          name: "bash",
          description: "Run bash",
          inputSchema: {
            type: "object",
            properties: { command: { type: "string" } },
            required: ["command"],
          },
        },
      ],
    });

    expect(result.toolCalls).toEqual([{ id: "toolu_1", name: "bash", input: { command: "pwd" } }]);
    expect(result.finishReason).toBe("tool_use");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("AnthropicAdapter runToolCallingTurn returns final text", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        stop_reason: "end_turn",
        content: [{ type: "text", text: "done" }],
      }),
      {
        headers: {
          "Content-Type": "application/json",
        },
      },
    )) as typeof fetch;

  try {
    const adapter = new AnthropicAdapter("test-key", "https://example.com");
    const result = await adapter.runToolCallingTurn({
      model: "claude-test",
      messages: [{ role: "user", content: "hello" }],
      tools: [],
    });

    expect(result.toolCalls).toEqual([]);
    expect(result.text).toBe("done");
    expect(result.finishReason).toBe("end_turn");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
