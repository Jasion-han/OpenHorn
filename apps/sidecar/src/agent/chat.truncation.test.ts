import { expect, test } from "bun:test";
import { runChatStream } from "./chat";
import type { AgentEvent } from "./events";

const partial = "```openui\nroot = Card(";

async function replay(reason: string, includeUsage: boolean, stop = false) {
  const originalFetch = globalThis.fetch;
  const frames = [
    { choices: [{ delta: { content: partial } }] },
    { choices: [{ delta: {}, finish_reason: reason }] },
    ...(includeUsage
      ? [{ choices: [], usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 } }]
      : []),
  ];
  globalThis.fetch = (async () =>
    new Response(
      `${frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("")}data: [DONE]\n\n`,
    )) as unknown as typeof fetch;
  const abortController = new AbortController();
  const events: AgentEvent[] = [];
  try {
    await runChatStream({
      apiKey: "fixture-key",
      protocol: "openai",
      model: "fixture",
      messages: [{ role: "user", content: "hi" }],
      abortController,
      onEvent: (event) => {
        events.push(event);
        if (stop && event.type === "text") abortController.abort();
      },
    });
    return events;
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("sidecar emits preserved partial, final usage, then one structured truncation error", async () => {
  const events = await replay("length", true);
  expect(events.map((event) => event.type)).toEqual(["text", "usage", "error"]);
  expect(events[0]).toEqual({ type: "text", content: partial });
  expect(events[1]).toEqual({
    type: "usage",
    promptTokens: 11,
    completionTokens: 7,
    totalTokens: 18,
  });
  expect(events[2]).toMatchObject({ type: "error", errorCode: "response_truncated" });
});

test("sidecar does not invent usage when the provider omits it", async () => {
  const events = await replay("length", false);
  expect(events.map((event) => event.type)).toEqual(["text", "error"]);
});

test("sidecar normal completion retains usage and done", async () => {
  expect((await replay("stop", true)).map((event) => event.type)).toEqual([
    "text",
    "usage",
    "done",
  ]);
});

test("sidecar Stop is never classified as output truncation", async () => {
  const events = await replay("length", true, true);
  expect(events.some((event) => event.type === "error")).toBe(false);
  expect(events[events.length - 1]).toEqual({ type: "done" });
});
