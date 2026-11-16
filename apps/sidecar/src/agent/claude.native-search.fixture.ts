import { expect, mock } from "bun:test";
import { createCheckpointSession } from "../checkpoints";

const cwd = process.argv[2];
let modelRequests = 0,
  nativeRequests = 0;
mock.module("@anthropic-ai/sdk", () => ({
  default: class {
    constructor(options: { apiKey: string }) {
      expect(options.apiKey).toBe("answer-claude-key");
    }
    messages = {
      stream: (input: { messages: unknown[] }) => {
        modelRequests++;
        expect(JSON.stringify(input.messages).includes("native-retrieval-key")).toBe(false);
        if (modelRequests > 1)
          expect(JSON.stringify(input.messages).includes("model_generated_summary")).toBe(true);
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
globalThis.fetch = (async (url, init) => {
  expect(String(url)).toBe("https://api.deepseek.com/v1/responses");
  expect((init?.headers as Record<string, string>).Authorization).toBe(
    "Bearer native-retrieval-key",
  );
  nativeRequests++;
  return Response.json({
    status: "completed",
    usage: { server_tool_use: { tool_search: 1 } },
    output: [
      { type: "web_search_call", status: "completed" },
      {
        type: "message",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: "Synthetic native summary",
            annotations: [{ type: "url_citation", url: "https://example.com/docs", title: "Docs" }],
          },
        ],
      },
    ],
  });
}) as typeof fetch;
const { runClaudeAgent } = await import("./claude");
const checkpoint = await createCheckpointSession(cwd);
const events: Array<{ type: string; content?: string }> = [];
await runClaudeAgent({
  apiKey: "answer-claude-key",
  model: "claude-fixture",
  prompt: "Find synthetic documentation",
  cwd,
  abortController: new AbortController(),
  checkpoint,
  onCheckpointReady: () => {},
  onSdkSessionId: () => {},
  requestApproval: async () => true,
  onEvent: (event) => events.push(event),
  webSearchEnabled: true,
  searchProvider: "deepseek-native",
  nativeSearchConnection: {
    baseUrl: "https://api.deepseek.com/v1",
    model: "deepseek-v4-pro",
    apiKey: "native-retrieval-key",
  },
});
expect(events.some((event) => event.type === "error")).toBe(false);
expect(nativeRequests).toBe(1);
expect(modelRequests).toBe(2);
console.log(JSON.stringify({ nativeRequests, modelRequests, separatedCredentials: true }));
