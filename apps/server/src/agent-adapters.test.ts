import { expect, test } from "bun:test";
import { OpenAIAdapter } from "./agent-adapters";

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
