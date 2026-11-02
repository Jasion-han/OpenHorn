import { describe, expect, test } from "bun:test";
import { type ChatUsage, createAdapter, type ProviderAdapter } from "./adapters";
import { ChatStreamTruncatedError, finishChatStream } from "./chatStreamError";

const partial = "```openui\nroot = Card(";
const usage: ChatUsage = { promptTokens: 11, completionTokens: 7, totalTokens: 18 };
const sse = (...events: unknown[]) =>
  events
    .map((event) => `data: ${typeof event === "string" ? event : JSON.stringify(event)}\n\n`)
    .join("");

async function collect(adapter: ProviderAdapter, signal?: AbortSignal) {
  const stream = adapter.chatStream({
    model: "fixture",
    messages: [{ role: "user", content: "hi" }],
    signal,
  });
  let text = "";
  try {
    while (true) {
      const step = await stream.next();
      if (step.done) return { text, usage: step.value, error: undefined };
      text += step.value;
    }
  } catch (error) {
    return { text, usage: undefined, error };
  }
}

async function withResponse(body: string, action: () => Promise<void>) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(body)) as unknown as typeof fetch;
  try {
    await action();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

const cases = [
  {
    protocol: "openai",
    reason: "length",
    normal: "stop",
    body: (reason: string, includeUsage: boolean, text = partial) =>
      sse(
        { choices: [{ delta: { content: text }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: reason }] },
        ...(includeUsage
          ? [{ choices: [], usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 } }]
          : []),
        "[DONE]",
      ),
  },
  {
    protocol: "anthropic",
    reason: "max_tokens",
    normal: "end_turn",
    body: (reason: string, includeUsage: boolean, text = partial) =>
      sse(
        {
          type: "message_start",
          message: { ...(includeUsage ? { usage: { input_tokens: 11, output_tokens: 0 } } : {}) },
        },
        { type: "content_block_delta", delta: { type: "text_delta", text } },
        {
          type: "message_delta",
          delta: { stop_reason: reason },
          ...(includeUsage ? { usage: { output_tokens: 7 } } : {}),
        },
        { type: "message_stop" },
      ),
  },
  {
    protocol: "google",
    reason: "MAX_TOKENS",
    normal: "STOP",
    body: (reason: string, includeUsage: boolean, text = partial) =>
      sse(
        { candidates: [{ content: { parts: [{ text }] } }] },
        {
          candidates: [{ finishReason: reason }],
          ...(includeUsage
            ? {
                usageMetadata: {
                  promptTokenCount: 11,
                  candidatesTokenCount: 7,
                  totalTokenCount: 18,
                },
              }
            : {}),
        },
      ),
  },
];

describe("explicit Chat output limits", () => {
  for (const fixture of cases) {
    test(`${fixture.protocol} preserves partial text and final usage in its typed failure`, async () => {
      await withResponse(fixture.body(fixture.reason, true), async () => {
        const result = await collect(createAdapter(fixture.protocol, "fixture-key"));
        expect(result.text).toBe(partial);
        expect(result.error instanceof ChatStreamTruncatedError).toBe(true);
        expect(result.error).toMatchObject({
          code: "response_truncated",
          finishReason: fixture.reason,
          usage,
        });
      });
    });

    test(`${fixture.protocol} reports empty truncation without fabricating usage`, async () => {
      await withResponse(fixture.body(fixture.reason, false, ""), async () => {
        const result = await collect(createAdapter(fixture.protocol, "fixture-key"));
        expect(result.text).toBe("");
        expect(result.error).toMatchObject({ code: "response_truncated" });
        expect((result.error as ChatStreamTruncatedError).usage).toBe(undefined);
      });
    });

    test(`${fixture.protocol} normal termination still returns usage`, async () => {
      await withResponse(fixture.body(fixture.normal, true), async () => {
        expect(await collect(createAdapter(fixture.protocol, "fixture-key"))).toEqual({
          text: partial,
          usage,
          error: undefined,
        });
      });
    });
  }

  test("OpenAI JSON fallback preserves content and does not swallow the typed failure", async () => {
    await withResponse(
      JSON.stringify({
        choices: [{ message: { content: partial }, finish_reason: "length" }],
        usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
      }),
      async () => {
        const result = await collect(createAdapter("openai", "fixture-key"));
        expect(result.text).toBe(partial);
        expect(result.error).toMatchObject({ code: "response_truncated", usage });
      },
    );
  });

  test("missing finish reason keeps existing gateway compatibility", async () => {
    await withResponse(sse({ choices: [{ delta: { content: partial } }] }, "[DONE]"), async () => {
      expect(await collect(createAdapter("openai", "fixture-key"))).toEqual({
        text: partial,
        usage: undefined,
        error: undefined,
      });
    });
  });

  test("Stop takes priority over provider output-limit metadata", () => {
    const controller = new AbortController();
    controller.abort();
    for (const fixture of cases)
      expect(finishChatStream(fixture.reason, usage, controller.signal)).toEqual(usage);
  });
});
