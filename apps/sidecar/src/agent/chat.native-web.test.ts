import { afterEach, expect, test } from "bun:test";
import { type RunChatStreamInput, runChatStream } from "./chat";
import type { AgentEvent } from "./events";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

async function run(reason: string, stop = false, disconnected = false) {
  const events: AgentEvent[] = [];
  const controller = new AbortController();
  let request: Record<string, unknown> = {};
  globalThis.fetch = (async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    request = JSON.parse(String(init?.body));
    const frames = [
      {
        choices: [
          {
            server_tool_event: {
              type: "call_started",
              step: 0,
              call: { id: "s1", action: { type: "search", queries: ["q"] } },
            },
            delta: {},
          },
        ],
      },
      { choices: [{ delta: { content: "partial" } }] },
      { choices: [{ delta: {}, finish_reason: reason }] },
    ];
    if (disconnected)
      return new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(
              new TextEncoder().encode(
                frames
                  .slice(0, 2)
                  .map((f) => `data: ${JSON.stringify(f)}\n\n`)
                  .join(""),
              ),
            );
          },
          pull(c) {
            c.error(new Error("fixture disconnect"));
          },
        }),
      );
    return new Response(
      `${frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join("")}data: [DONE]\n\n`,
    );
  }) as unknown as typeof fetch;
  await runChatStream({
    apiKey: "fixture",
    baseUrl: "https://api.deepseek.com",
    protocol: "openai",
    model: "deepseek-flash",
    nativeWeb: { search: true, readUrls: true, thinking: false },
    messages: [{ role: "user", content: "hi" }],
    abortController: controller,
    onEvent(event) {
      events.push(event);
      if (stop && event.type === "text") controller.abort();
    },
  });
  return { events, request };
}
test("native sidecar forwards chat_metadata and refusal retracts text before one terminal error", async () => {
  const { events, request } = await run("content_filter");
  expect(request.thinking).toEqual({ type: "disabled" });
  expect(events.map((event) => event.type)).toEqual([
    "chat_metadata",
    "text",
    "clear_streaming_text",
    "chat_metadata",
    "error",
  ]);
  expect(events.at(-1)).toMatchObject({ type: "error", errorCode: "response_refused" });
});
test("native sidecar Stop keeps partial and ignores late refusal", async () => {
  const { events } = await run("content_filter", true);
  expect(events.map((event) => event.type)).toEqual(["chat_metadata", "text", "done"]);
});
test("native sidecar disconnect keeps received metadata and partial text", async () => {
  const { events } = await run("stop", false, true);
  expect(events.map((event) => event.type)).toEqual(["chat_metadata", "text", "error"]);
});

test("sidecar drops mismatched 70KB replay state before budget and retains pure-text history", async () => {
  for (const model of ["deepseek-v4-flash-vision-exp", "deepseek-flash"]) {
    const signature = "s".repeat(70 * 1024);
    const messages: RunChatStreamInput["messages"] = [
      { role: "user", content: "old question" },
      {
        role: "assistant",
        content: "old answer",
        providerState: {
          provider: "deepseek",
          origin: "https://api.deepseek.com",
          model: "deepseek-flash",
          serverToolCalls: [
            {
              index: 0,
              calls: [
                {
                  index: 0,
                  id: "read1",
                  type: "deepseek_read_url",
                  kind: "read_link",
                  status: "completed",
                  action: { type: "read_link", url: "https://example.com" },
                  signature,
                },
              ],
            },
          ],
        },
      },
      { role: "user", content: "new question" },
    ];
    const before = JSON.stringify(messages);
    let payload:
      | { messages: Array<{ role: string; content: unknown; server_tool_calls?: unknown }> }
      | undefined;
    globalThis.fetch = (async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      payload = JSON.parse(String(init?.body));
      return new Response(
        'data: {"choices":[{"delta":{"content":"answer"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      );
    }) as unknown as typeof fetch;
    const events: AgentEvent[] = [];
    await runChatStream({
      apiKey: "fixture",
      baseUrl: "https://api.deepseek.com/v1",
      protocol: "openai",
      model,
      contextWindow: 8192,
      messages,
      abortController: new AbortController(),
      onEvent: (event) => events.push(event),
    });
    expect(events.at(-1)).toEqual({ type: "done" });
    if (model !== "deepseek-flash") {
      expect(payload?.messages).toEqual(messages.map(({ role, content }) => ({ role, content })));
    } else {
      expect(payload?.messages).toEqual([
        { role: "system", content: "[2 earlier messages omitted]" },
        { role: "user", content: "new question" },
      ]);
    }
    expect(JSON.stringify(messages)).toBe(before);
  }
});
