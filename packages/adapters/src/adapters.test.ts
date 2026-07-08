import { expect, test } from "bun:test";
import { AnthropicAdapter, GoogleAdapter, OpenAIAdapter } from "./adapters";
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

// Like `sseResponse` but enqueues raw byte chunks, so a test can split a
// multi-byte UTF-8 character across the chunk boundary.
function rawSseResponse(byteChunks: Uint8Array[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of byteChunks) {
        controller.enqueue(chunk);
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

// Like `mockFetch` but records the arguments of each call so tests can assert on
// how the request was formed (URL, headers, body).
function mockFetchCapture(response: Response) {
  const calls: Array<{ input: FetchInput; init: FetchInit }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: FetchInput, init: FetchInit) => {
    calls.push({ input, init });
    return response;
  }) as unknown as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
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

test("OpenAIAdapter streaming does not double a tool name repeated across chunks", async () => {
  // Some gateways resend the full function.name on every tool-call delta.
  const restore = mockFetch(
    sseResponse([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_a","function":{"name":"get_weather","arguments":"{\\"city\\":"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"get_weather","arguments":"\\"NYC\\"}"}}]}}]}\n\n',
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
    expect(result?.toolCalls).toHaveLength(1);
    expect(result?.toolCalls[0]).toEqual({
      id: "call_a",
      name: "get_weather",
      input: { city: "NYC" },
    });
  } finally {
    restore();
  }
});

test("OpenAIAdapter streaming keeps a later index-less fragment off an explicit index:0 slot", async () => {
  // A stream that mixes explicit indices with index-less fragments carrying a
  // fresh id: the synthetic slot must not collide with the real index:0 entry.
  const restore = mockFetch(
    sseResponse([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_a","function":{"name":"get_weather","arguments":"{\\"city\\":\\"NYC\\"}"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"id":"call_b","function":{"name":"get_time","arguments":"{\\"tz\\":\\"UTC\\"}"}}]}}]}\n\n',
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

test("AnthropicAdapter.chatStream emits the final delta when the body has no trailing newline", async () => {
  const restore = mockFetch(
    sseResponse([
      'data: {"type":"content_block_delta","delta":{"text":"Hello"}}\n\n',
      // Final SSE line arrives WITHOUT a closing newline.
      'data: {"type":"content_block_delta","delta":{"text":" world"}}',
    ]),
  );
  try {
    const adapter = new AnthropicAdapter("test-key", "https://example.com");
    const chunks: string[] = [];
    for await (const chunk of adapter.chatStream({
      model: "claude-test",
      messages: [{ role: "user", content: "hi" }],
    })) {
      chunks.push(chunk);
    }
    expect(chunks.join("")).toBe("Hello world");
  } finally {
    restore();
  }
});

test("AnthropicAdapter.chatStream flushes a multi-byte char split across the final chunk", async () => {
  const encoder = new TextEncoder();
  const line1 = encoder.encode('data: {"type":"content_block_delta","delta":{"text":"Hi"}}\n\n');
  // Final line ends in the 3-byte "世" and has no trailing newline.
  const line2 = encoder.encode('data: {"type":"content_block_delta","delta":{"text":"世"}}');
  const splitAt = line2.length - 1; // last byte of 世 lands alone in the final chunk
  const chunkA = new Uint8Array([...line1, ...line2.slice(0, splitAt)]);
  const chunkB = line2.slice(splitAt);
  const restore = mockFetch(rawSseResponse([chunkA, chunkB]));
  try {
    const adapter = new AnthropicAdapter("test-key", "https://example.com");
    const chunks: string[] = [];
    for await (const chunk of adapter.chatStream({
      model: "claude-test",
      messages: [{ role: "user", content: "hi" }],
    })) {
      chunks.push(chunk);
    }
    expect(chunks.join("")).toBe("Hi世");
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// Anthropic — parallel tool results coalesce into ONE user message
// (avoids the "messages: roles must alternate" 400)
// ---------------------------------------------------------------------------

test("AnthropicAdapter.runToolCallingTurn coalesces parallel tool results into one user message", async () => {
  const capture = mockFetchCapture(
    jsonResponse({
      content: [{ type: "text", text: "done" }],
      stop_reason: "end_turn",
    }),
  );
  try {
    const adapter = new AnthropicAdapter("test-key", "https://example.com");
    await adapter.runToolCallingTurn({
      model: "claude-test",
      messages: [
        { role: "user", content: "list and read" },
        {
          role: "assistant",
          content: "",
          toolCalls: [
            { id: "call_a", name: "list_files", input: {} },
            { id: "call_b", name: "read_file", input: { path: "/foo" } },
          ],
        },
        { role: "tool", toolCallId: "call_a", name: "list_files", content: "a.txt" },
        { role: "tool", toolCallId: "call_b", name: "read_file", content: "hello" },
      ],
      tools: [
        { name: "list_files", description: "list", inputSchema: {} },
        { name: "read_file", description: "read", inputSchema: {} },
      ],
    });
    expect(capture.calls).toHaveLength(1);
    const body = JSON.parse(String(capture.calls[0].init?.body));
    // user, assistant(tool_use x2), then a SINGLE user message with two tool_result blocks
    expect(body.messages).toHaveLength(3);
    const toolResultMsg = body.messages[2];
    expect(toolResultMsg.role).toBe("user");
    expect(toolResultMsg.content).toHaveLength(2);
    expect(toolResultMsg.content[0]).toEqual({
      type: "tool_result",
      tool_use_id: "call_a",
      content: "a.txt",
    });
    expect(toolResultMsg.content[1]).toEqual({
      type: "tool_result",
      tool_use_id: "call_b",
      content: "hello",
    });
  } finally {
    capture.restore();
  }
});

// ---------------------------------------------------------------------------
// Google — safety-blocked streaming surfaces an error (no silent blank turn)
// ---------------------------------------------------------------------------

test("GoogleAdapter.chatStream throws when the generation is safety-blocked", async () => {
  const restore = mockFetch(
    sseResponse(['data: {"candidates":[{"content":{"parts":[]},"finishReason":"SAFETY"}]}\n\n']),
  );
  try {
    const adapter = new GoogleAdapter("test-key", "https://example.com");
    const chunks: string[] = [];
    let caught: Error | null = null;
    try {
      for await (const chunk of adapter.chatStream({
        model: "gemini-test",
        messages: [{ role: "user", content: "hi" }],
      })) {
        chunks.push(chunk);
      }
    } catch (error) {
      caught = error as Error;
    }
    expect(chunks.join("")).toBe("");
    expect(caught).toBeDefined();
    expect(caught?.message).toBe(
      "Provider API error (200): Generation stopped by Gemini (finishReason: SAFETY)",
    );
  } finally {
    restore();
  }
});

test("GoogleAdapter.chatStream emits the final delta when the body has no trailing newline", async () => {
  const restore = mockFetch(
    sseResponse([
      'data: {"candidates":[{"content":{"parts":[{"text":"Hello"}]}}]}\n\n',
      // Final SSE line arrives WITHOUT a closing newline.
      'data: {"candidates":[{"content":{"parts":[{"text":" world"}]}}]}',
    ]),
  );
  try {
    const adapter = new GoogleAdapter("test-key", "https://example.com");
    const chunks: string[] = [];
    for await (const chunk of adapter.chatStream({
      model: "gemini-test",
      messages: [{ role: "user", content: "hi" }],
    })) {
      chunks.push(chunk);
    }
    expect(chunks.join("")).toBe("Hello world");
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// Google — chat() blocked prompt produces a specific error
// ---------------------------------------------------------------------------

test("GoogleAdapter.chat throws a specific error when the prompt is blocked", async () => {
  const restore = mockFetch(
    jsonResponse({
      promptFeedback: { blockReason: "SAFETY" },
      candidates: [],
    }),
  );
  try {
    const adapter = new GoogleAdapter("test-key", "https://example.com");
    await expect(
      adapter.chat({
        model: "gemini-test",
        messages: [{ role: "user", content: "hi" }],
      }),
    ).rejects.toThrow("Prompt blocked by Gemini safety filters (blockReason: SAFETY)");
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// Google — API key travels in the x-goog-api-key header, not the URL query
// ---------------------------------------------------------------------------

test("GoogleAdapter.chat sends the API key as a header, not a query param", async () => {
  const capture = mockFetchCapture(
    jsonResponse({
      candidates: [{ content: { parts: [{ text: "hello" }] } }],
      usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 3, totalTokenCount: 5 },
    }),
  );
  try {
    const adapter = new GoogleAdapter("secret-key", "https://example.com");
    const result = await adapter.chat({
      model: "gemini-test",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(result.content).toBe("hello");
    expect(capture.calls).toHaveLength(1);
    const call = capture.calls[0];
    const url = String(call.input);
    expect(url.includes("key=")).toBe(false);
    const headers = (call.init?.headers ?? {}) as Record<string, string>;
    expect(headers["x-goog-api-key"]).toBe("secret-key");
  } finally {
    capture.restore();
  }
});

// ---------------------------------------------------------------------------
// Google — partial usage is reported when only one token count is present
// ---------------------------------------------------------------------------

test("GoogleAdapter.chat reports partial usage when only one token count exists", async () => {
  const restore = mockFetch(
    jsonResponse({
      candidates: [{ content: { parts: [{ text: "hi" }] } }],
      usageMetadata: { promptTokenCount: 7 },
    }),
  );
  try {
    const adapter = new GoogleAdapter("test-key", "https://example.com");
    const result = await adapter.chat({
      model: "gemini-test",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(result.usage).toEqual({ promptTokens: 7, completionTokens: 0, totalTokens: 7 });
  } finally {
    restore();
  }
});
