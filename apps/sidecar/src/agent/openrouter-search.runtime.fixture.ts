import { expect, mock } from "bun:test";
import * as piAi from "@earendil-works/pi-ai";
import { OPENROUTER_SEARCH_MODEL } from "shared/openrouter-search";
import type { SearchExecutionSource } from "shared/types";
import { createCheckpointSession } from "../checkpoints";
import * as realMcp from "./mcp-tools";

const cwd = process.argv[2];
const runtime = process.argv[3];
const provider = process.argv[4] === "tavily" ? "tavily" : "openrouter";
let modelRequests = 0,
  searchRequests = 0;
const retrievalKey = "synthetic-openrouter-key";
let competingMcpCalls = 0;
const mcpTool = (name: string, description: string) => ({
  name,
  label: name,
  description,
  parameters: { type: "object", properties: { query: { type: "string" } } },
  execute: async () => {
    competingMcpCalls++;
    throw new Error("Unexpected competing MCP request");
  },
});
const fakeMcpModule = { ...realMcp };
mock.module("./mcp-tools", () => ({
  ...fakeMcpModule,
  connectMcpTools: async () => ({
    toolsByServer: [
      {
        serverName: "tavily-hikari",
        tools: [
          mcpTool("mcp__tavily-hikari__tavily_search", "Search the web"),
          mcpTool("mcp__tavily-hikari__tavily_extract", "Read a specific URL"),
        ],
      },
    ],
    cleanup: async () => {},
  }),
}));
function checkContext(messages: unknown[]) {
  const serialized = JSON.stringify(messages);
  expect(serialized.includes(retrievalKey)).toBe(false);
  expect(serialized.includes("private-reasoning")).toBe(false);
  if (modelRequests > 1)
    expect(
      serialized.includes(
        provider === "openrouter" ? "model_generated_summary" : "Untrusted provider summary",
      ),
    ).toBe(true);
}
if (runtime === "claude") {
  mock.module("@anthropic-ai/sdk", () => ({
    default: class {
      constructor(options: { apiKey: string }) {
        expect(options.apiKey).toBe("answer-model-key");
      }
      messages = {
        stream: (input: { messages: unknown[] }) => {
          modelRequests++;
          checkContext(input.messages);
          const stream = {
            on: () => stream,
            finalMessage: async () => ({
              content:
                modelRequests === 1
                  ? [
                      {
                        type: "tool_use",
                        id: "search1",
                        name: "WebSearch",
                        input: { query: "Synthetic docs" },
                      },
                    ]
                  : [{ type: "text", text: "Synthetic answer" }],
              usage: { input_tokens: 1, output_tokens: 1 },
              stop_reason: modelRequests === 1 ? "tool_use" : "end_turn",
            }),
          };
          return stream;
        },
      };
    },
  }));
} else {
  const realPi = { ...piAi };
  mock.module("@earendil-works/pi-ai", () => ({
    ...realPi,
    streamSimple: (
      model: piAi.Model<piAi.Api>,
      context: piAi.Context,
      options: { apiKey: string },
    ) => {
      modelRequests++;
      expect(options.apiKey).toBe("answer-model-key");
      checkContext(context.messages);
      const names = context.tools?.map((tool) => tool.name) ?? [];
      expect(names.includes("web_search")).toBe(true);
      expect(names.includes("mcp__tavily-hikari__tavily_search")).toBe(false);
      expect(names.includes("mcp__tavily-hikari__tavily_extract")).toBe(true);
      const stream = realPi.createAssistantMessageEventStream();
      const message: piAi.AssistantMessage = {
        role: "assistant",
        api: model.api,
        provider: model.provider,
        model: model.id,
        timestamp: Date.now(),
        stopReason: modelRequests === 1 ? "toolUse" : "stop",
        content:
          modelRequests === 1
            ? [
                {
                  type: "toolCall",
                  id: "search1",
                  name: "web_search",
                  arguments: { query: "Synthetic docs" },
                },
              ]
            : [{ type: "text", text: "Synthetic answer" }],
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
      queueMicrotask(() => {
        stream.push({ type: "start", partial: message });
        stream.push({
          type: "done",
          reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
          message,
        });
        stream.end(message);
      });
      return stream;
    },
  }));
}
globalThis.fetch = (async (url, init) => {
  if (provider === "tavily") {
    expect(String(url)).toBe("https://api.tavily.com/search");
    expect(JSON.parse(String(init?.body)).api_key).toBe(retrievalKey);
    searchRequests++;
    return Response.json({
      answer: "Synthetic Tavily summary",
      results: [
        { url: "https://example.com/docs", title: "Docs", content: "Original source excerpt" },
      ],
    });
  }
  expect(String(url)).toBe("https://openrouter.ai/api/v1/chat/completions");
  expect(new Headers(init?.headers).get("Authorization")).toBe(`Bearer ${retrievalKey}`);
  expect(JSON.parse(String(init?.body)).model).toBe(OPENROUTER_SEARCH_MODEL);
  searchRequests++;
  return Response.json({
    choices: [
      {
        finish_reason: "stop",
        message: {
          role: "assistant",
          content: "Synthetic summary",
          reasoning: "private-reasoning",
          annotations: [
            {
              type: "url_citation",
              url_citation: { url: "https://example.com/docs", title: "Docs" },
            },
          ],
        },
      },
    ],
  });
}) as typeof fetch;
const events: Array<{ type: string; content?: string; searchSource?: SearchExecutionSource }> = [];
const input = {
  apiKey: "answer-model-key",
  model: "answer-fixture",
  prompt: "Find synthetic documentation",
  cwd,
  abortController: new AbortController(),
  checkpoint: await createCheckpointSession(cwd),
  onCheckpointReady: () => {},
  onSdkSessionId: () => {},
  requestApproval: async () => true,
  onEvent: (event: { type: string; content?: string; searchSource?: SearchExecutionSource }) =>
    events.push(event),
  webSearchEnabled: true,
  searchProvider: provider as "tavily" | "openrouter",
  tavilyApiKey: retrievalKey,
  mcpServers: { "tavily-hikari": { command: "unused" } },
  openRouterSearchConnection: {
    baseUrl: "https://openrouter.ai/api/v1" as const,
    model: OPENROUTER_SEARCH_MODEL as typeof OPENROUTER_SEARCH_MODEL,
    engine: "exa" as const,
    apiKey: retrievalKey,
  },
};
if (runtime === "claude") await (await import("./claude")).runClaudeAgent(input);
else await (await import("./direct")).runDirectAgent(input);
expect(events.filter((event) => event.type === "error")).toEqual([]);
expect(searchRequests).toBe(1);
expect(modelRequests).toBe(2);
expect(competingMcpCalls).toBe(0);
expect(events.find((event) => event.type === "tool_result")?.searchSource).toEqual({ provider });
expect(
  events.some((event) => event.type === "tool_start" && event.searchSource?.provider === provider),
).toBe(true);
expect(JSON.stringify(events).includes(retrievalKey)).toBe(false);
console.log(JSON.stringify({ searchRequests, modelRequests, separatedCredentials: true }));
