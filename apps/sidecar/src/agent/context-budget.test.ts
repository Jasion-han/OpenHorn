import { expect, test } from "bun:test";
import { boundChatContext, estimateContextMessageTokens } from "shared/context-budget";
import { runChatStream } from "./chat";
import { runCodexChat } from "./chatCodex";
import { buildHistoryMessages, HISTORY_MAX_TOKENS, truncateHistory } from "./context";
import type { AgentEvent } from "./events";
import { withConversationHistory } from "./runtimePrompt";

test("an oversized latest historical answer leaves an omission notice", () => {
  const history = [
    { role: "user" as const, content: "earlier question" },
    { role: "assistant" as const, content: "x".repeat(90_000) },
  ];
  const bounded = truncateHistory(history, HISTORY_MAX_TOKENS);
  expect(bounded).toEqual([{ role: "user", content: "[2 earlier messages omitted]" }]);
  expect(buildHistoryMessages(bounded, "current request").prompt).toBe(
    "[2 earlier messages omitted]\n\ncurrent request",
  );
  expect(withConversationHistory("current request", history, { model: "fixture" })).toContain(
    "[2 earlier messages omitted]",
  );
});

test("a history that fits without a notice stays intact at the exact boundary", () => {
  const history = [
    { role: "user" as const, content: "a" },
    { role: "assistant" as const, content: "b" },
  ];
  expect(truncateHistory(history, 22)).toEqual(history);
});

test("history notices consume the history allocation and preserve strict alternation", () => {
  const bounded = truncateHistory(
    [
      { role: "user", content: "x".repeat(1_000) },
      { role: "assistant", content: "x".repeat(1_000) },
      { role: "user", content: "recent" },
      { role: "assistant", content: "answer" },
    ],
    45,
  );
  expect(
    bounded.reduce((sum, message) => sum + Math.ceil(message.content.length / 3.5) + 10, 0) <= 45,
  ).toBe(true);
  const result = buildHistoryMessages(bounded, "current");
  expect(result.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
  expect(result.prompt).toBe("current");
  expect(() => truncateHistory([{ role: "user", content: "x".repeat(100) }], 1)).toThrow(
    "omission notice",
  );
});

test("the final Chat entry counts UI instructions before a real local adapter request", async () => {
  const requests: Array<{ messages: Array<{ role: string; content: string }> }> = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      requests.push((await request.json()) as (typeof requests)[number]);
      return new Response(
        'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":null}]}\n\n' +
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
          "data: [DONE]\n\n",
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  try {
    const events: AgentEvent[] = [];
    const input = {
      model: "fixture",
      protocol: "openai",
      apiKey: "fixture",
      baseUrl: `http://127.0.0.1:${server.port}/v1`,
      abortController: new AbortController(),
      onEvent: (event: AgentEvent) => events.push(event),
    };
    const uiInstructions = "Auto UI component instructions\n".repeat(1_000);
    const prepared = boundChatContext([
      { role: "system" as const, content: "global" },
      { role: "user" as const, content: "earlier question" },
      { role: "assistant" as const, content: "x".repeat(90_000) },
      { role: "user" as const, content: "current request" },
    ]);
    expect(prepared).toHaveLength(4);
    const messages = prepared.map((message) =>
      message.role === "system"
        ? { ...message, content: `${message.content}\n\n${uiInstructions}` }
        : message,
    );
    await runChatStream({ ...input, messages });
    expect(requests).toHaveLength(1);
    const submitted = requests[0]?.messages ?? [];
    expect(submitted.at(-1)).toEqual({ role: "user", content: "current request" });
    expect(JSON.stringify(submitted).includes("earlier messages omitted")).toBe(true);
    expect(JSON.stringify(submitted).includes("Auto UI component instructions")).toBe(true);
    expect(
      submitted.reduce(
        (sum, message) =>
          sum + estimateContextMessageTokens({ role: "user", content: message.content }),
        0,
      ) <= 32_000,
    ).toBe(true);
    expect(events.at(-1)?.type).toBe("done");

    events.length = 0;
    await runChatStream({
      ...input,
      messages: [
        { role: "system", content: uiInstructions },
        { role: "user", content: "x".repeat(100_000) },
      ],
    });
    expect(requests).toHaveLength(1);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "error", errorCode: "chat_context_budget_exceeded" });
    expect(JSON.stringify(events)).toContain("estimated context budget");
  } finally {
    await server.stop(true);
  }
});

test("Codex Chat rejects an over-budget final payload before discovering or spawning a CLI", async () => {
  let discovered = false;
  const events: AgentEvent[] = [];
  await runCodexChat(
    {
      model: "fixture",
      messages: [
        { role: "system", content: "UI schema".repeat(5_000) },
        { role: "user", content: "x".repeat(100_000) },
      ],
      abortController: new AbortController(),
      onEvent: (event) => events.push(event),
    },
    {
      findBinary: async () => {
        discovered = true;
        return null;
      },
    },
  );
  expect(discovered).toBe(false);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ type: "error", errorCode: "chat_context_budget_exceeded" });
  expect(JSON.stringify(events)).toContain("estimated context budget");
});

test("a 1M Chat stream submits an above32K request with complete system and history to a local adapter", async () => {
  const requests: Array<{ messages: Array<{ role: string; content: string }> }> = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      requests.push((await request.json()) as (typeof requests)[number]);
      return new Response(
        'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":null}]}\n\ndata: [DONE]\n\n',
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  try {
    const messages = [
      { role: "system" as const, content: "Instructions" },
      { role: "user" as const, content: "history".repeat(20_000) },
      { role: "assistant" as const, content: "previous answer" },
      { role: "user" as const, content: `CURRENT-BEGIN${"x".repeat(200_000)}CURRENT-END` },
    ];
    const events: AgentEvent[] = [];
    await runChatStream({
      model: "gpt-6-astra",
      protocol: "openai",
      apiKey: "fixture",
      baseUrl: `http://127.0.0.1:${server.port}/v1`,
      messages,
      abortController: new AbortController(),
      onEvent: (event) => events.push(event),
    });
    expect(requests).toHaveLength(1);
    expect(requests[0].messages).toEqual(messages);
    expect(events.at(-1)?.type).toBe("done");
  } finally {
    await server.stop(true);
  }
});
