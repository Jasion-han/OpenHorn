import { afterEach, expect, test } from "bun:test";
import { boundChatContext } from "shared/context-budget";
import type { ProviderChatMetadata } from "shared/types";
import { type ChatMessage, OpenAIAdapter } from "./adapters";
import { deepseekNativeWebIdentity, validateProviderChatState } from "./deepseek-native-web";
import { filterChatProviderState } from "./index";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});
const nativeWeb = { search: true, readUrls: true, thinking: true };
const calls = [
  {
    index: 0,
    reasoning_content: "",
    calls: [
      {
        index: 0,
        id: "read-1",
        type: "deepseek_read_url",
        kind: "read_link",
        action: { type: "read_link", url: "https://example.com" },
        status: "completed",
        page: { url: "https://example.com", title: "Example" },
        signature: "opaque+signature/==",
      },
    ],
  },
];
const state = {
  provider: "deepseek" as const,
  origin: "https://api.deepseek.com",
  model: "deepseek-flash",
  serverToolCalls: calls,
};
function replay(frames: unknown[], requests: Record<string, unknown>[] = []) {
  globalThis.fetch = (async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)));
    return new Response(
      `${frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("")}data: [DONE]\n\n`,
    );
  }) as unknown as typeof fetch;
}
async function collect(adapter: OpenAIAdapter, metadata: ProviderChatMetadata[], options = {}) {
  const stream = adapter.chatStream({
    model: "deepseek-flash",
    messages: [{ role: "user", content: "hi" }],
    nativeWeb,
    onMetadata: (m) => metadata.push(m),
    ...options,
  });
  let text = "";
  while (true) {
    const next = await stream.next();
    if (next.done) return { text, usage: next.value };
    text += next.value;
  }
}

test("official native wire preserves terminal signatures, source-only citations, snapshots and usage", async () => {
  const requests: Record<string, unknown>[] = [];
  replay(
    [
      {
        choices: [
          {
            server_tool_event: {
              type: "call_started",
              step: 0,
              call: { ...calls[0].calls[0], status: undefined },
            },
            delta: {},
          },
        ],
      },
      { choices: [{ delta: { content: "😀answer" } }] },
      {
        choices: [
          {
            delta: {
              server_tool_calls: calls,
              annotations: [
                {
                  type: "url_citation",
                  url_citation: {
                    url: "https://example.com",
                    title: "Example",
                    start_index: 1,
                    end_index: 7,
                  },
                },
                { type: "url_citation", url_citation: { url: "javascript:alert(1)" } },
              ],
            },
            finish_reason: "stop",
          },
        ],
      },
      {
        choices: [],
        usage: {
          prompt_tokens: 3,
          completion_tokens: 4,
          total_tokens: 7,
          server_tool_use: { tool_search: 1, tool_fetch: 2, tool_image_search: 0 },
        },
      },
    ],
    requests,
  );
  const metadata: ProviderChatMetadata[] = [];
  expect(
    await collect(new OpenAIAdapter("fixture", "https://api.deepseek.com/v1"), metadata),
  ).toEqual({ text: "😀answer", usage: { promptTokens: 3, completionTokens: 4, totalTokens: 7 } });
  expect(requests[0].tools).toEqual([
    { type: "deepseek_web_search" },
    { type: "deepseek_read_url" },
  ]);
  expect(requests[0].thinking).toEqual({ type: "enabled" });
  expect(metadata[0].steps?.[0].status).toBe("in_progress");
  expect(metadata.at(-1)).toMatchObject({
    providerState: state,
    citations: [{ url: "https://example.com/", title: "Example" }],
    toolUsage: { search: 1, fetch: 2, imageSearch: 0 },
  });
  expect(metadata[0].steps?.[0].status).toBe("in_progress");
});

test("only exact official endpoint and supported model receive private fields; matching state replays even tools off", async () => {
  for (const [url, model, allowed] of [
    ["https://api.deepseek.com", "deepseek-flash", true],
    ["https://api.deepseek.com/v1", "deepseek-v4-flash-vision-exp", true],
    ["https://gateway.invalid", "deepseek-flash", false],
    ["https://api.deepseek.com/beta", "deepseek-flash", false],
    ["https://api.deepseek.com", "deepseek-chat", false],
    ["https://api.deepseek.com.evil.invalid", "deepseek-flash", false],
  ] as const) {
    const requests: Record<string, unknown>[] = [];
    replay([{ choices: [{ delta: {}, finish_reason: "stop" }] }], requests);
    await collect(new OpenAIAdapter("fixture", url), [], {
      model,
      messages: [
        { role: "assistant", content: "prior", providerState: state },
        { role: "user", content: "next" },
      ],
    });
    expect(Boolean(requests[0].tools)).toBe(allowed);
    expect(JSON.stringify(requests[0]).includes("providerState")).toBe(false);
    expect(Boolean((requests[0].messages as Record<string, unknown>[])[0].server_tool_calls)).toBe(
      allowed && model === state.model,
    );
  }
  const requests: Record<string, unknown>[] = [];
  replay([{ choices: [{ delta: {}, finish_reason: "stop" }] }], requests);
  await collect(new OpenAIAdapter("fixture", state.origin), [], {
    nativeWeb: undefined,
    messages: [
      { role: "assistant", content: "prior", providerState: state },
      { role: "user", content: "next" },
    ],
  });
  expect((requests[0].messages as Record<string, unknown>[])[0].server_tool_calls).toEqual(calls);
  expect(requests[0].tools).toBeUndefined();
});

test("state validator rejects malformed, oversized and mismatched identities without truncating signatures", () => {
  expect(validateProviderChatState(JSON.stringify(state))).toEqual(state);
  expect(validateProviderChatState(state, { origin: state.origin, model: "other" })).toBeNull();
  expect(validateProviderChatState({ ...state, origin: "https://gateway.invalid" })).toBeNull();
  expect(
    validateProviderChatState({
      ...state,
      serverToolCalls: [{ calls: [{ signature: "x".repeat(300_000) }] }],
    }),
  ).toBeNull();
  expect(validateProviderChatState({ ...state, serverToolCalls: [{}] })).toBeNull();
  expect(deepseekNativeWebIdentity("https://user:pass@api.deepseek.com", state.model)).toBeNull();
});

test("refusal separately clears citations and emits typed error after terminal metadata, usage retained", async () => {
  replay([
    { choices: [{ delta: { content: "unsafe partial" } }] },
    { choices: [{ delta: { server_tool_calls: calls }, finish_reason: "content_filter" }] },
    { choices: [], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } },
  ]);
  const metadata: ProviderChatMetadata[] = [];
  await expect(collect(new OpenAIAdapter("fixture", state.origin), metadata)).rejects.toMatchObject(
    { code: "response_refused", usage: { totalTokens: 3 } },
  );
  expect(metadata.some((m) => m.refused === true && m.citations?.length === 0)).toBe(true);
});

test("Stop suppresses late metadata and refusal", async () => {
  replay([
    { choices: [{ delta: { content: "partial" } }] },
    { choices: [{ delta: { server_tool_calls: calls }, finish_reason: "content_filter" }] },
  ]);
  const controller = new AbortController();
  const metadata: ProviderChatMetadata[] = [];
  const stream = new OpenAIAdapter("fixture", state.origin).chatStream({
    model: state.model,
    nativeWeb,
    messages: [{ role: "user", content: "hi" }],
    signal: controller.signal,
    onMetadata: (m) => metadata.push(m),
  });
  expect((await stream.next()).value).toBe("partial");
  controller.abort();
  try {
    await stream.next();
  } catch {}
  expect(metadata).toEqual([]);
});

test("nonstreaming and JSON-stream fallback both retain terminal metadata and typed refusal", async () => {
  const requests: Record<string, unknown>[] = [];
  globalThis.fetch = (async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)));
    return Response.json({
      id: "json",
      model: state.model,
      choices: [
        {
          message: {
            content: "answer",
            server_tool_calls: calls,
            annotations: [
              {
                type: "url_citation",
                url_citation: { url: "https://example.com", title: "Example" },
              },
            ],
          },
          finish_reason: "stop",
        },
      ],
    });
  }) as unknown as typeof fetch;
  const metadata: ProviderChatMetadata[] = [];
  const adapter = new OpenAIAdapter("fixture", state.origin);
  expect(
    (
      await adapter.chat({
        model: state.model,
        nativeWeb,
        messages: [{ role: "user", content: "hi" }],
        onMetadata: (m) => metadata.push(m),
      })
    ).content,
  ).toBe("answer");
  expect(metadata.at(-1)?.providerState).toEqual(state);
  expect((await collect(adapter, metadata)).text).toBe("answer");
  expect(requests[0].tools).toEqual(requests[1].tools);
});

test("a paid native request is not automatically retried on provider failure", async () => {
  let attempts = 0;
  globalThis.fetch = (async () => {
    attempts++;
    return Response.json({ error: { message: "fixture busy" } }, { status: 503 });
  }) as unknown as typeof fetch;
  await expect(collect(new OpenAIAdapter("fixture", state.origin), [])).rejects.toThrow(
    "fixture busy",
  );
  expect(attempts).toBe(1);
});

test("truncation preserves terminal metadata and disconnect preserves the last process snapshot", async () => {
  replay([
    { choices: [{ delta: { content: "partial" } }] },
    { choices: [{ delta: { server_tool_calls: calls }, finish_reason: "length" }] },
  ]);
  const metadata: ProviderChatMetadata[] = [];
  await expect(collect(new OpenAIAdapter("fixture", state.origin), metadata)).rejects.toMatchObject(
    { code: "response_truncated" },
  );
  expect(metadata.at(-1)?.providerState).toEqual(state);
});

test("native EOF without a terminal verdict is a partial failure, never a completed answer", async () => {
  globalThis.fetch = (async () =>
    new Response(
      `data: ${JSON.stringify({ choices: [{ delta: { content: "partial" } }] })}\n\n`,
    )) as unknown as typeof fetch;
  const stream = new OpenAIAdapter("fixture", state.origin).chatStream({
    model: state.model,
    nativeWeb,
    messages: [{ role: "user", content: "hi" }],
  });
  expect((await stream.next()).value).toBe("partial");
  await expect(stream.next()).rejects.toThrow("before completion");
});

test("a disconnect after a refusal verdict cannot downgrade it to an ordinary partial failure", async () => {
  globalThis.fetch = (async () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "content_filter" }] })}\n\n`,
            ),
          );
        },
        pull(controller) {
          controller.error(new Error("fixture disconnected after safety verdict"));
        },
      }),
    )) as unknown as typeof fetch;
  await expect(collect(new OpenAIAdapter("fixture", state.origin), [])).rejects.toMatchObject({
    code: "response_refused",
  });
});

test("provider state is filtered before budget without mutating the stored transcript", () => {
  const signedState = {
    ...state,
    serverToolCalls: [
      { ...calls[0], calls: [{ ...calls[0].calls[0], signature: "s".repeat(70 * 1024) }] },
    ],
  };
  const messages: ChatMessage[] = [
    { role: "user", content: "original question" },
    Object.freeze({
      role: "assistant" as const,
      content: "original answer",
      providerState: signedState,
    }),
    { role: "user", content: "follow up" },
  ];
  const before = JSON.stringify(messages);
  for (const [protocol, baseUrl, model] of [
    ["openai", "https://api.deepseek.com", "deepseek-v4-flash-vision-exp"],
    ["openai", "https://gateway.invalid/v1", "deepseek-flash"],
    ["anthropic", "https://api.deepseek.com", "deepseek-flash"],
    ["openai", null, "deepseek-flash"],
  ] as const) {
    const filtered = filterChatProviderState(messages, protocol, baseUrl, model);
    expect(filtered).toEqual(messages.map(({ role, content }) => ({ role, content })));
    expect(boundChatContext(filtered, { maxTokens: 1000 })).toEqual(filtered);
  }
  expect(JSON.stringify(messages)).toBe(before);
  expect(messages[1].providerState).toBe(signedState);
});

test("matching provider state remains complete and consumes the normal whole-turn budget", () => {
  const signedState = {
    ...state,
    serverToolCalls: [
      { ...calls[0], calls: [{ ...calls[0].calls[0], signature: "s".repeat(70 * 1024) }] },
    ],
  };
  const messages: ChatMessage[] = [
    { role: "user", content: "old question" },
    { role: "assistant", content: "old answer", providerState: signedState },
    { role: "user", content: "new question" },
  ];
  const filtered = filterChatProviderState(
    messages,
    "openai",
    "https://api.deepseek.com/v1",
    state.model,
  );
  expect(filtered[1].providerState).toBe(signedState);
  expect(boundChatContext(filtered, { maxTokens: 30000 })).toEqual(messages);
  expect(boundChatContext(filtered, { maxTokens: 1000 })).toEqual([
    { role: "system", content: "[2 earlier messages omitted]" },
    { role: "user", content: "new question" },
  ]);
});
