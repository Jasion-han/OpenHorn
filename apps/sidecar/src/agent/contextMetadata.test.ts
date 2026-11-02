import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ChatContextBudgetError } from "shared/context-budget";
import { resolveContextPolicy } from "shared/context-policy";
import type { ModelContextMetadata } from "shared/types";
import { validateMethodParams } from "../protocol";
import { runChatStream } from "./chat";
import { boundAgentHistory } from "./contextPolicy";
import { buildModel, runDirectAgent } from "./direct";
import type { AgentEvent } from "./events";

const metadata: ModelContextMetadata = {
  contextWindow: 262_144,
  maxInputTokens: 200_000,
  maxOutputTokens: 1_024,
  source: "channel",
  fetchedAt: 1_793_600_000_000,
};
const servers: Array<ReturnType<typeof Bun.serve>> = [];
const directories: string[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop(true);
  for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true });
});

const openaiStream =
  'data: {"id":"fixture","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}\n\ndata: {"id":"fixture","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
const googleStream =
  'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"ok"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":1,"totalTokenCount":11}}\n\n';
const anthropicStream = [
  {
    type: "message_start",
    message: {
      id: "fixture",
      type: "message",
      role: "assistant",
      model: "dynamic-non-gpt",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 0 },
    },
  },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
  { type: "content_block_stop", index: 0 },
  {
    type: "message_delta",
    delta: { stop_reason: "end_turn", stop_sequence: null },
    usage: { output_tokens: 1 },
  },
  { type: "message_stop" },
]
  .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
  .join("");

function provider(protocol: string) {
  const requests: Array<Record<string, unknown>> = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      requests.push((await request.json()) as Record<string, unknown>);
      return new Response(
        protocol === "google"
          ? googleStream
          : protocol === "anthropic"
            ? anthropicStream
            : openaiStream,
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  servers.push(server);
  return { requests, baseUrl: `http://127.0.0.1:${server.port}/v1` };
}

for (const method of ["chat.stream", "agent.run"]) {
  test(`${method} retains only normalized discovery fields and rejects malformed reported ceilings`, () => {
    const base =
      method === "chat.stream"
        ? { model: "dynamic-non-gpt", protocol: "openai", messages: [] }
        : { model: "dynamic-non-gpt", prompt: "q" };
    const wire = validateMethodParams(method, {
      ...base,
      contextMetadata: { ...metadata, unexpectedSecret: "discard" },
    }) as { contextMetadata: ModelContextMetadata };
    expect(wire.contextMetadata).toEqual(metadata);
    for (const contextWindow of [4096, 16_777_216]) {
      const automatic = validateMethodParams(method, {
        ...base,
        contextWindow: null,
        contextMetadata: { ...metadata, contextWindow },
      }) as { contextMetadata: ModelContextMetadata };
      expect(automatic.contextMetadata.contextWindow).toBe(contextWindow);
    }
    for (const invalid of [
      [],
      "metadata",
      { ...metadata, maxInputTokens: "200000" },
      { ...metadata, maxOutputTokens: 0 },
      { ...metadata, contextWindow: 16_777_217 },
      { ...metadata, source: "invented" },
      { ...metadata, fetchedAt: -1 },
      { ...metadata, inputLimitOnly: "true" },
    ]) {
      expect(() => validateMethodParams(method, { ...base, contextMetadata: invalid })).toThrow();
    }
  });
}

test("unlisted Agent models honor reported input/output ceilings across descriptor and history guards", () => {
  const input = {
    model: "dynamic-non-gpt",
    contextMetadata: metadata,
    contextWindow: 1_000_000,
    apiKey: "fixture",
    prompt: "q",
    cwd: "/tmp",
    abortController: new AbortController(),
    onEvent: () => {},
  };
  for (const protocol of ["openai", "google"]) {
    const model = buildModel({ ...input, protocol }, false);
    expect(model.contextWindow).toBe(262_144);
    expect(model.maxTokens).toBe(1_024);
    const policy = resolveContextPolicy({ ...input, protocol, mode: "agent" });
    expect(policy.maxInputTokens).toBe(200_000);
  }
  expect(() => boundAgentHistory(input, { prompt: "x".repeat(750_000) })).toThrow(
    ChatContextBudgetError,
  );
  expect(
    boundAgentHistory(
      {
        ...input,
        conversationHistory: [
          { role: "user", content: "h".repeat(150_000) },
          { role: "assistant", content: "a" },
        ],
      },
      { prompt: "current" },
    ),
  ).toHaveLength(2);
});

for (const protocol of ["openai", "google", "anthropic"]) {
  test(`reported non-GPT capabilities reach actual ${protocol} Chat request and enforce maxOutput1024`, async () => {
    const { requests, baseUrl } = provider(protocol);
    const events: AgentEvent[] = [];
    await runChatStream({
      model: "dynamic-non-gpt",
      protocol,
      apiKey: "fixture",
      baseUrl,
      contextMetadata: metadata,
      messages: [{ role: "user", content: `BEGIN${"x".repeat(200_000)}END` }],
      abortController: new AbortController(),
      onEvent: (event) => events.push(event),
    });
    expect(requests).toHaveLength(1);
    expect(
      protocol === "google"
        ? (requests[0].generationConfig as { maxOutputTokens: number }).maxOutputTokens
        : (requests[0].max_tokens ?? requests[0].max_completion_tokens),
    ).toBe(1_024);
    expect(JSON.stringify(requests[0])).toContain("BEGIN");
    expect(JSON.stringify(requests[0])).toContain("END");
    expect(events.some((event) => event.type === "error")).toBe(false);
    expect(events.at(-1)?.type).toBe("done");
    events.length = 0;
    await runChatStream({
      model: "dynamic-non-gpt",
      protocol,
      apiKey: "fixture",
      baseUrl,
      contextMetadata: metadata,
      messages: [{ role: "user", content: "x".repeat(750_000) }],
      abortController: new AbortController(),
      onEvent: (event) => events.push(event),
    });
    expect(requests).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "error", errorCode: "chat_context_budget_exceeded" });
  });
}

for (const protocol of ["openai", "google"]) {
  test(`reported non-GPT output1024 is applied to the real Direct ${protocol} request`, async () => {
    const { requests, baseUrl } = provider(protocol);
    const cwd = await mkdtemp(path.join(tmpdir(), "openhorn-discovered-runtime-"));
    directories.push(cwd);
    const events: AgentEvent[] = [];
    await runDirectAgent({
      model: "dynamic-non-gpt",
      protocol,
      contextMetadata: metadata,
      apiKey: "fixture",
      baseUrl,
      cwd,
      checkpoint: { runId: "fixture", workspaceRoot: cwd, checkpointDir: cwd, files: new Map() },
      prompt: "current",
      webSearchEnabled: false,
      abortController: new AbortController(),
      onEvent: (event) => events.push(event),
    });
    expect(requests).toHaveLength(1);
    expect(
      protocol === "google"
        ? (requests[0].generationConfig as { maxOutputTokens: number }).maxOutputTokens
        : (requests[0].max_tokens ?? requests[0].max_completion_tokens),
    ).toBe(1_024);
    expect(events.some((event) => event.type === "error")).toBe(false);
    expect(events.at(-1)?.type).toBe("done");
  });
}
