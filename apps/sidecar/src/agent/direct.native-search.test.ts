import { expect, test } from "bun:test";
import { executeTool, runWebSearch } from "./direct";

const connection = {
  baseUrl: "https://api.deepseek.com/v1",
  model: "deepseek-v4-pro",
  apiKey: "native-retrieval-key",
};
const payload = () => ({
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
          text: "Synthetic source-backed summary",
          annotations: [
            { type: "url_citation", url: "https://example.com/docs", title: "Synthetic docs" },
          ],
        },
      ],
    },
  ],
});

test("Agent Search uses its native retrieval connection regardless of the answer-model or other search credentials", async () => {
  let calls = 0;
  const result = await runWebSearch("Synthetic docs", {
    searchProvider: "deepseek-native",
    nativeSearchConnection: connection,
    tavilyApiKey: "wrong-tavily",
    deepseekApiKey: "wrong-standalone",
    fetchImpl: async (url, init) => {
      calls++;
      expect(String(url)).toBe("https://api.deepseek.com/v1/responses");
      expect((init?.headers as Record<string, string>).Authorization).toBe(
        "Bearer native-retrieval-key",
      );
      return Response.json(payload());
    },
  });
  expect(calls).toBe(1);
  expect(result.includes("model_generated_summary")).toBe(true);
  expect(result.includes("https://example.com/docs")).toBe(true);
  expect(result.includes("native-retrieval-key")).toBe(false);
});

test("failed or absent native Search never borrows Tavily and the web permission still gates calls", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return Response.json({ status: "completed", output: [] });
  };
  const failed = await runWebSearch("docs", {
    searchProvider: "deepseek-native",
    nativeSearchConnection: connection,
    tavilyApiKey: "do-not-use",
    fetchImpl,
  });
  expect(failed.includes("do not claim a search")).toBe(true);
  expect(calls).toBe(1);
  await runWebSearch("docs", {
    searchProvider: "deepseek-native",
    tavilyApiKey: "do-not-use",
    fetchImpl,
  });
  expect(calls).toBe(1);
  const disabled = await executeTool("web_search", { query: "docs" }, "/tmp", {
    nativeSearchConnection: connection,
    searchProvider: "deepseek-native",
    webSearchEnabled: false,
    fetchImpl,
  });
  expect(disabled).toBe("Error: web access is disabled");
  expect(calls).toBe(1);
});

test("explicit URL Fetch returns page text without sending native API credentials or substituting a model summary", async () => {
  const result = await executeTool("web_fetch", { url: "https://example.com/docs" }, "/tmp", {
    webSearchEnabled: true,
    searchProvider: "deepseek-native",
    nativeSearchConnection: connection,
    resolveHostname: async () => ["93.184.216.34"],
    fetchImpl: async (url, init) => {
      expect(String(url)).toBe("https://example.com/docs");
      expect(new Headers(init?.headers).get("Authorization")).toBe(null);
      return new Response("Synthetic original page text", {
        headers: { "Content-Type": "text/plain" },
      });
    },
  });
  expect(result.includes("Synthetic original page text")).toBe(true);
  expect(result.includes("model_generated_summary")).toBe(false);
});
