import { expect, test } from "bun:test";
import {
  __clearDuckDuckGoCache,
  parseDuckDuckGoLiteHtml,
  searchDuckDuckGo,
} from "./duckduckgoProvider";

const noSleep = async () => {};

const SAMPLE_HTML = `<table>
<tr><td><a rel="nofollow" href="https://a.com/one" class='result-link'>First Result</a></td></tr>
<tr><td class='result-snippet'>Snippet for first &amp; only.</td></tr>
<tr><td><a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fb.com%2Ftwo&rut=x" class='result-link'>Second Result</a></td></tr>
<tr><td class='result-snippet'>Snippet for second.</td></tr>
</table>`;

test("parseDuckDuckGoLiteHtml extracts titles, urls and snippets", () => {
  const citations = parseDuckDuckGoLiteHtml(SAMPLE_HTML, 10);
  expect(citations).toHaveLength(2);
  expect(citations[0]).toMatchObject({
    title: "First Result",
    url: "https://a.com/one",
    snippet: "Snippet for first & only.",
  });
});

test("parseDuckDuckGoLiteHtml decodes uddg redirect links", () => {
  const citations = parseDuckDuckGoLiteHtml(SAMPLE_HTML, 10);
  expect(citations[1].url).toBe("https://b.com/two");
});

test("parseDuckDuckGoLiteHtml respects maxResults", () => {
  const citations = parseDuckDuckGoLiteHtml(SAMPLE_HTML, 1);
  expect(citations).toHaveLength(1);
});

test("searchDuckDuckGo returns parsed citations from the lite endpoint", async () => {
  __clearDuckDuckGoCache();
  const result = await searchDuckDuckGo("ai news unique-a", {
    fetchImpl: async (input, init) => {
      expect(String(input)).toContain("lite.duckduckgo.com");
      expect((init?.method ?? "").toUpperCase()).toBe("POST");
      return new Response(SAMPLE_HTML);
    },
    sleep: noSleep,
  });
  expect(result).toHaveLength(2);
  expect(result[0].url).toBe("https://a.com/one");
});

test("searchDuckDuckGo retries on 202 soft rate-limit then succeeds", async () => {
  __clearDuckDuckGoCache();
  let calls = 0;
  const result = await searchDuckDuckGo("ai news unique-b", {
    sleep: noSleep,
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) return new Response("", { status: 202 });
      return new Response(SAMPLE_HTML);
    },
  });
  expect(calls).toBe(2);
  expect(result).toHaveLength(2);
});

test("searchDuckDuckGo returns empty array when soft-limited past retry budget", async () => {
  __clearDuckDuckGoCache();
  const result = await searchDuckDuckGo("ai news unique-c", {
    sleep: noSleep,
    maxRetries: 1,
    fetchImpl: async () => new Response("", { status: 202 }),
  });
  expect(result).toEqual([]);
});

test("searchDuckDuckGo caches results within the TTL window", async () => {
  __clearDuckDuckGoCache();
  let calls = 0;
  const opts = {
    sleep: noSleep,
    now: () => 1_000,
    fetchImpl: async () => {
      calls += 1;
      return new Response(SAMPLE_HTML);
    },
  };
  await searchDuckDuckGo("ai news unique-d", opts);
  await searchDuckDuckGo("ai news unique-d", opts);
  expect(calls).toBe(1);
});

test("searchDuckDuckGo returns empty array on network error", async () => {
  __clearDuckDuckGoCache();
  const result = await searchDuckDuckGo("ai news unique-e", {
    sleep: noSleep,
    maxRetries: 0,
    fetchImpl: async () => {
      throw new Error("network down");
    },
  });
  expect(result).toEqual([]);
});
