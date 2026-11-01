import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runChatStream } from "./chat";
import { runDirectAgent } from "./direct";
import type { AgentEvent } from "./events";

const directories: string[] = [];
const servers: Array<ReturnType<typeof Bun.serve>> = [];
const instructions = "Fixture interactive instructions: emit openui blocks when useful.";
const finalText = '```openui\nroot = Card("Fixture", TextContent("Done"))\n```';

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop(true);
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

const chunk = (delta: unknown, finishReason: string | null = null, usage?: unknown) =>
  `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: "fixture", choices: [{ index: 0, delta, finish_reason: finishReason }], ...(usage ? { usage } : {}) })}\n\n`;

async function setup() {
  const cwd = await mkdtemp(path.join(tmpdir(), "openhorn-runtime-modes-"));
  directories.push(cwd);
  return {
    cwd,
    checkpoint: { runId: "fixture", workspaceRoot: cwd, checkpointDir: cwd, files: new Map() },
  };
}

describe("local provider mode matrix", () => {
  for (const interactive of [false, true]) {
    test(`Chat streams history and per-run instructions with Interactive ${interactive ? "on" : "off"}`, async () => {
      const requests: Array<{ messages: Array<{ role: string; content: string }> }> = [];
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: async (request) => {
          requests.push(
            (await request.json()) as { messages: Array<{ role: string; content: string }> },
          );
          return new Response(
            chunk({ content: finalText }) +
              chunk({}, "stop", { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 }) +
              "data: [DONE]\n\n",
            { headers: { "content-type": "text/event-stream" } },
          );
        },
      });
      servers.push(server);
      const messages = [
        { role: "system" as const, content: interactive ? `global\n${instructions}` : "global" },
        { role: "user" as const, content: "earlier question" },
        { role: "assistant" as const, content: "earlier answer" },
        { role: "user" as const, content: "current question" },
      ];
      const originalMessages = JSON.stringify(messages);
      const events: AgentEvent[] = [];
      await runChatStream({
        model: "fixture",
        protocol: "openai",
        apiKey: "fixture",
        baseUrl: `http://127.0.0.1:${server.port}/v1`,
        messages,
        abortController: new AbortController(),
        onEvent: (event) => events.push(event),
      });
      expect(requests).toHaveLength(1);
      expect(requests[0].messages).toEqual(messages);
      expect(
        events
          .filter((event) => event.type === "text")
          .map((event) => (event as { content?: string }).content)
          .join(""),
      ).toBe(finalText);
      expect(events).toContainEqual({
        type: "usage",
        promptTokens: 12,
        completionTokens: 4,
        totalTokens: 16,
      });
      expect(events.at(-1)?.type).toBe("done");
      expect(JSON.stringify(messages)).toBe(originalMessages);
    });

    test(`Direct Agent performs two provider steps and preserves history with Interactive ${interactive ? "on" : "off"}`, async () => {
      const s = await setup();
      await writeFile(path.join(s.cwd, "fixture.txt"), "fixture file contents");
      const requests: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: async (request) => {
          requests.push(
            (await request.json()) as { messages: Array<{ role: string; content: unknown }> },
          );
          const body =
            requests.length === 1
              ? chunk({ role: "assistant", content: "Read fixture first." }) +
                chunk({
                  tool_calls: [
                    {
                      index: 0,
                      id: "fixture-read",
                      type: "function",
                      function: { name: "read_file", arguments: '{"path":"fixture.txt"}' },
                    },
                  ],
                }) +
                chunk({}, "tool_calls", {
                  prompt_tokens: 10,
                  completion_tokens: 2,
                  total_tokens: 12,
                })
              : chunk({ content: finalText }) +
                chunk({}, "stop", { prompt_tokens: 15, completion_tokens: 3, total_tokens: 18 });
          return new Response(`${body}data: [DONE]\n\n`, {
            headers: { "content-type": "text/event-stream" },
          });
        },
      });
      servers.push(server);
      const events: AgentEvent[] = [];
      const history = [
        { role: "user" as const, content: "earlier question" },
        { role: "assistant" as const, content: "earlier answer" },
      ];
      await runDirectAgent({
        ...s,
        model: "fixture",
        apiKey: "fixture",
        baseUrl: `http://127.0.0.1:${server.port}/v1`,
        prompt: "current question",
        conversationHistory: history,
        systemPrompt: interactive ? instructions : undefined,
        webSearchEnabled: false,
        abortController: new AbortController(),
        onEvent: (event) => events.push(event),
      });
      expect(requests).toHaveLength(2);
      const serialized = JSON.stringify(requests[0].messages);
      expect(serialized.includes(instructions)).toBe(interactive);
      expect(serialized).toContain("earlier question");
      expect(serialized).toContain("earlier answer");
      expect(JSON.stringify(requests[1].messages)).toContain("fixture file contents");
      expect(
        events.some((event) => event.type === "tool_start" && event.toolName === "read_file"),
      ).toBe(true);
      expect(
        events.some(
          (event) =>
            event.type === "tool_result" && event.content?.includes("fixture file contents"),
        ),
      ).toBe(true);
      expect(events.filter((event) => event.type === "error")).toEqual([]);
      expect(events.filter((event) => event.type === "done")).toHaveLength(1);
      expect(events).toContainEqual({
        type: "usage",
        promptTokens: 25,
        completionTokens: 5,
        totalTokens: 30,
      });
      expect(history).toEqual([
        { role: "user", content: "earlier question" },
        { role: "assistant", content: "earlier answer" },
      ]);
    });
  }

  test("Direct Stop during asynchronous setup never reaches provider", async () => {
    const s = await setup();
    let requests = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => {
        requests++;
        return new Response(
          `${chunk({ content: finalText })}${chunk({}, "stop")}data: [DONE]\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    servers.push(server);
    const controller = new AbortController();
    const events: AgentEvent[] = [];
    const run = runDirectAgent({
      ...s,
      model: "fixture",
      apiKey: "fixture",
      baseUrl: `http://127.0.0.1:${server.port}/v1`,
      prompt: "fixture question",
      webSearchEnabled: false,
      abortController: controller,
      onEvent: (event) => events.push(event),
    });
    controller.abort();
    await run;
    expect(requests).toBe(0);
    expect(events.at(-1)?.type).toBe("done");
  });

  test("Direct Stop after partial provider output ends the run once", async () => {
    const s = await setup();
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(chunk({ content: "partial fixture" })));
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    });
    servers.push(server);
    const controller = new AbortController();
    const events: AgentEvent[] = [];
    await runDirectAgent({
      ...s,
      model: "fixture",
      apiKey: "fixture",
      baseUrl: `http://127.0.0.1:${server.port}/v1`,
      prompt: "fixture question",
      webSearchEnabled: false,
      abortController: controller,
      onEvent: (event) => {
        events.push(event);
        if (event.type === "final_text") controller.abort();
      },
    });
    expect(controller.signal.aborted).toBe(true);
    expect(events.filter((event) => event.type === "done")).toHaveLength(1);
    expect(
      events.some((event) => event.type === "final_text" && event.content === "partial fixture"),
    ).toBe(true);
  });
});
