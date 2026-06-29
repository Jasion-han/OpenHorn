import { expect, test } from "bun:test";
import { __clearDuckDuckGoCache } from "shared/search";
import { runWebSearch } from "./direct";

const noSleep = async () => {};

const DDG_LITE_HTML = `<table>
<tr><td><a rel="nofollow" href="https://example.com/news" class='result-link'>AI News Today</a></td></tr>
<tr><td class='result-snippet'>Latest updates from the AI world.</td></tr>
</table>`;

test("runWebSearch falls back to DuckDuckGo when no tavily key exists", async () => {
  __clearDuckDuckGoCache();
  const result = await runWebSearch("最近 AI 圈有什么新闻 (sidecar-ddg-1)", {
    sleep: noSleep,
    fetchImpl: async (input) => {
      expect(String(input).includes("duckduckgo.com")).toBe(true);
      return new Response(DDG_LITE_HTML);
    },
  });

  expect(result.includes("https://example.com/news")).toBe(true);
  expect(result.includes("AI News Today")).toBe(true);
});

test("runWebSearch uses Tavily when a key is configured", async () => {
  __clearDuckDuckGoCache();
  const result = await runWebSearch("推送今天科技新闻 (sidecar-tavily-1)", {
    tavilyApiKey: "test-key",
    sleep: noSleep,
    fetchImpl: async (input, init) => {
      expect(String(input).includes("api.tavily.com")).toBe(true);
      const body = JSON.parse(String(init?.body ?? "{}")) as { api_key?: string; topic?: string };
      expect(body.api_key).toBe("test-key");
      expect(body.topic).toBe("news");
      return new Response(
        JSON.stringify({
          answer: "Here is a summary.",
          results: [{ title: "Tech News", url: "https://ithome.com/0/1", content: "details" }],
        }),
      );
    },
  });

  expect(result.includes("Here is a summary.")).toBe(true);
  expect(result.includes("https://ithome.com/0/1")).toBe(true);
});

test("runWebSearch degrades to DuckDuckGo when Tavily upstream fails", async () => {
  __clearDuckDuckGoCache();
  const result = await runWebSearch("最近科技新闻 (sidecar-degrade-1)", {
    tavilyApiKey: "test-key",
    sleep: noSleep,
    fetchImpl: async (input) => {
      if (String(input).includes("api.tavily.com")) {
        return new Response("upstream down", { status: 500 });
      }
      return new Response(DDG_LITE_HTML);
    },
  });

  expect(result.includes("https://example.com/news")).toBe(true);
});

test("runWebSearch returns an error for an empty query", async () => {
  const result = await runWebSearch("   ");
  expect(result).toBe("Error: query is required");
});
