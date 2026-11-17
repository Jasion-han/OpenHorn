import { expect, test } from "bun:test";
import { executeTool } from "./direct";
import type { AgentEvent } from "./events";
import { runResearchAgent } from "./research";

for (const protocol of ["openai", "anthropic", "google"])
  test(`research runs a controlled ${protocol} model/search/page/report round through real adapters`, async () => {
    const original = globalThis.fetch;
    const events: AgentEvent[] = [];
    let models = 0,
      searches = 0,
      pages = 0;
    const source = "https://example.com/research-evidence";
    const wire: unknown[] = [];
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("https://model.test.invalid/")) {
        const body = JSON.parse(String(init?.body));
        wire.push(body);
        expect(JSON.stringify(body).includes("synthetic-search-key")).toBe(false);
        const index = models++;
        const name = index < 2 ? "web_search" : "web_fetch";
        const args = index < 2 ? { query: `angle ${index}` } : { url: source };
        const text =
          index === 4
            ? `Report: verified [original evidence](${source}).`
            : "Plan and check evidence";
        if (protocol === "openai")
          return Response.json({
            choices: [
              {
                message:
                  index < 3
                    ? {
                        content: "",
                        tool_calls: [
                          {
                            id: `call-${index}`,
                            type: "function",
                            function: { name, arguments: JSON.stringify(args) },
                          },
                        ],
                      }
                    : { content: text },
                finish_reason: index < 3 ? "tool_calls" : "stop",
              },
            ],
          });
        if (protocol === "anthropic")
          return Response.json({
            content:
              index < 3
                ? [{ type: "tool_use", id: `call-${index}`, name, input: args }]
                : [{ type: "text", text }],
            stop_reason: index < 3 ? "tool_use" : "end_turn",
          });
        return Response.json({
          candidates: [
            {
              content: { parts: index < 3 ? [{ functionCall: { name, args } }] : [{ text }] },
              finishReason: "STOP",
            },
          ],
        });
      }
      if (url === "https://api.tavily.com/search") {
        const body = JSON.parse(String(init?.body));
        expect(body.api_key).toBe("synthetic-search-key");
        expect(JSON.stringify(body).includes("synthetic-answer-key")).toBe(false);
        searches++;
        return Response.json({
          results: [
            { title: "Original evidence", url: source, content: "A controlled primary source" },
          ],
        });
      }
      if (url === source) {
        expect(new Headers(init?.headers).has("authorization")).toBe(false);
        pages++;
        return new Response("Original page confirms the measured result.", {
          headers: { "Content-Type": "text/plain" },
        });
      }
      throw new Error("Unexpected external request in controlled research test");
    }) as unknown as typeof fetch;
    try {
      await runResearchAgent(
        {
          cwd: "/tmp/research-protocol",
          protocol,
          baseUrl: "https://model.test.invalid/v1",
          apiKey: "synthetic-answer-key",
          model: "gpt-4o",
          prompt: "Compare evidence",
          webSearchEnabled: true,
          searchProvider: "tavily",
          tavilyApiKey: "synthetic-search-key",
          abortController: new AbortController(),
          onEvent: (event) => events.push(event),
        },
        {
          execute: (name, args, cwd, options) =>
            executeTool(name, args, cwd, {
              ...options,
              fetchImpl: globalThis.fetch,
              resolveHostname: async () => ["93.184.216.34"],
            }),
        },
      );
      expect(models).toBe(5);
      expect(searches).toBe(2);
      expect(pages).toBe(1);
      expect(events.at(-1)?.type).toBe("done");
      expect(events.some((event) => event.type === "text" && event.content.includes(source))).toBe(
        true,
      );
      expect(JSON.stringify(wire).includes("Original page confirms")).toBe(true);
      expect(
        events.some(
          (event) => event.type === "tool_result" && event.searchSource?.provider === "tavily",
        ),
      ).toBe(true);
    } finally {
      globalThis.fetch = original;
    }
  });
