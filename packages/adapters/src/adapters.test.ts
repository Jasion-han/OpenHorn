import { expect, test } from "bun:test";
import { AnthropicAdapter, OpenAIAdapter } from "./adapters";
import type { GenericToolDefinition } from "./types";

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

function jsonResponse(obj: unknown): Response {
  return new Response(JSON.stringify(obj), {
    headers: { "Content-Type": "application/json" },
  });
}

function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream" },
  });
}

function mockFetch(response: Response) {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => response) as unknown as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

// ---------------------------------------------------------------------------
// OpenAI non-stream chat
// ---------------------------------------------------------------------------

test("OpenAIAdapter.chat extracts content from a happy-path response", async () => {
  const restore = mockFetch(
    jsonResponse({
      id: "resp-1",
      model: "gpt-test",
      choices: [{ message: { content: "hello world" } }],
      usage: { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 },
    }),
  );
  try {
    const adapter = new OpenAIAdapter("test-key", "https://example.com");
    const result = await adapter.chat({
      model: "gpt-test",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(result.content).toBe("hello world");
    expect(result.id).toBe("resp-1");
    expect(result.usage).toEqual({ promptTokens: 3, completionTokens: 5, totalTokens: 8 });
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// OpenAI streaming chat
// ---------------------------------------------------------------------------

test("OpenAIAdapter.chatStream assembles text deltas in order", async () => {
  const restore = mockFetch(
    sseResponse([
      'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"lo, "}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"world"}}]}\n\n',
      "data: [DONE]\n\n",
    ]),
  );
  try {
    const adapter = new OpenAIAdapter("test-key", "https://example.com");
    const chunks: string[] = [];
    for await (const chunk of adapter.chatStream({
      model: "gpt-test",
      messages: [{ role: "user", content: "hi" }],
    })) {
      chunks.push(chunk);
    }
    expect(chunks.join("")).toBe("Hello, world");
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// OpenAI streaming tool calls — parallel calls with no `index` (Fix 2)
// ---------------------------------------------------------------------------

const parallelTools: GenericToolDefinition[] = [
  { name: "get_weather", description: "weather", inputSchema: {} },
  { name: "get_time", description: "time", inputSchema: {} },
];

test("OpenAIAdapter streaming keeps parallel tool calls distinct when index is missing", async () => {
  // A gateway that omits `index`; new calls are identified by a fresh `id`.
  const restore = mockFetch(
    sseResponse([
      'data: {"choices":[{"delta":{"tool_calls":[{"id":"call_a","function":{"name":"get_weather","arguments":"{\\"city\\":"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"function":{"arguments":"\\"NYC\\"}"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"id":"call_b","function":{"name":"get_time","arguments":"{\\"tz\\":"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"function":{"arguments":"\\"UTC\\"}"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      "data: [DONE]\n\n",
    ]),
  );
  try {
    const adapter = new OpenAIAdapter("test-key", "https://example.com");
    let result: { toolCalls: Array<{ id: string; name: string; input: unknown }> } | null = null;
    for await (const event of adapter.runToolCallingTurnStream({
      model: "gpt-test",
      messages: [{ role: "user", content: "hi" }],
      tools: parallelTools,
    })) {
      if (event.type === "done") result = event.result;
    }
    expect(result).toBeDefined();
    expect(result?.toolCalls).toHaveLength(2);
    expect(result?.toolCalls[0]).toEqual({
      id: "call_a",
      name: "get_weather",
      input: { city: "NYC" },
    });
    expect(result?.toolCalls[1]).toEqual({
      id: "call_b",
      name: "get_time",
      input: { tz: "UTC" },
    });
  } finally {
    restore();
  }
});

test("OpenAIAdapter streaming still honors explicit tool-call index", async () => {
  const restore = mockFetch(
    sseResponse([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_a","function":{"name":"get_weather","arguments":"{\\"city\\":\\"NYC\\"}"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"id":"call_b","function":{"name":"get_time","arguments":"{\\"tz\\":\\"UTC\\"}"}}]}}]}\n\n',
      "data: [DONE]\n\n",
    ]),
  );
  try {
    const adapter = new OpenAIAdapter("test-key", "https://example.com");
    let result: { toolCalls: Array<{ id: string; name: string }> } | null = null;
    for await (const event of adapter.runToolCallingTurnStream({
      model: "gpt-test",
      messages: [{ role: "user", content: "hi" }],
      tools: parallelTools,
    })) {
      if (event.type === "done") result = event.result;
    }
    expect(result?.toolCalls).toHaveLength(2);
    expect(result?.toolCalls[0].name).toBe("get_weather");
    expect(result?.toolCalls[1].name).toBe("get_time");
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// Truncated tool-call arguments with finish_reason "length" (Fix 3/4)
// ---------------------------------------------------------------------------

test("OpenAIAdapter.runToolCallingTurn throws on truncated tool-call arguments", async () => {
  const restore = mockFetch(
    jsonResponse({
      choices: [
        {
          message: {
            content: "",
            tool_calls: [
              {
                id: "c1",
                type: "function",
                function: { name: "read_file", arguments: '{"path": "/foo' },
              },
            ],
          },
          finish_reason: "length",
        },
      ],
    }),
  );
  try {
    const adapter = new OpenAIAdapter("test-key", "https://example.com");
    await expect(
      adapter.runToolCallingTurn({
        model: "gpt-test",
        messages: [{ role: "user", content: "hi" }],
        tools: [{ name: "read_file", description: "read", inputSchema: {} }],
      }),
    ).rejects.toThrow("truncated");
  } finally {
    restore();
  }
});

test("OpenAIAdapter.runToolCallingTurn keeps empty tool-call arguments as {}", async () => {
  const restore = mockFetch(
    jsonResponse({
      choices: [
        {
          message: {
            content: "",
            tool_calls: [
              {
                id: "c1",
                type: "function",
                function: { name: "list_files", arguments: "" },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    }),
  );
  try {
    const adapter = new OpenAIAdapter("test-key", "https://example.com");
    const result = await adapter.runToolCallingTurn({
      model: "gpt-test",
      messages: [{ role: "user", content: "hi" }],
      tools: [{ name: "list_files", description: "list", inputSchema: {} }],
    });
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].input).toEqual({});
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// Anthropic non-stream chat — content[0] is a non-text block (Fix 1)
// ---------------------------------------------------------------------------

test("AnthropicAdapter.chat extracts text when a thinking block precedes it", async () => {
  const restore = mockFetch(
    jsonResponse({
      id: "msg-1",
      model: "claude-test",
      content: [
        { type: "thinking", thinking: "let me reason" },
        { type: "text", text: "the answer" },
      ],
      usage: { input_tokens: 4, output_tokens: 6 },
    }),
  );
  try {
    const adapter = new AnthropicAdapter("test-key", "https://example.com");
    const result = await adapter.chat({
      model: "claude-test",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(result.content).toBe("the answer");
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// Anthropic streaming chat — mid-stream error event (Fix 5)
// ---------------------------------------------------------------------------

test("AnthropicAdapter.chatStream throws on a mid-stream error event", async () => {
  const restore = mockFetch(
    sseResponse([
      'data: {"type":"content_block_delta","delta":{"text":"partial"}}\n\n',
      'data: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n',
    ]),
  );
  try {
    const adapter = new AnthropicAdapter("test-key", "https://example.com");
    const chunks: string[] = [];
    let caught: Error | null = null;
    try {
      for await (const chunk of adapter.chatStream({
        model: "claude-test",
        messages: [{ role: "user", content: "hi" }],
      })) {
        chunks.push(chunk);
      }
    } catch (error) {
      caught = error as Error;
    }
    expect(chunks.join("")).toBe("partial");
    expect(caught).toBeDefined();
    expect(caught?.message).toBe("Provider API error: Overloaded");
  } finally {
    restore();
  }
});
