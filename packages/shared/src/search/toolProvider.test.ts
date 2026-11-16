import { expect, test } from "bun:test";
import { normalizeToolBaseUrl, parseToolConnectionConfig } from "../tool-connection";
import { fetchToolService, searchToolService } from "./toolProvider";

const connection = {
  kind: "deepseek" as const,
  baseUrl: "https://relay.example.com/api/v1",
  apiKey: "relay-key",
};
const dns = async () => ["93.184.216.34"];
const json = (body: unknown) => new Response(JSON.stringify(body));

test("tool connections normalize paths and reject credentials and unsafe destinations", () => {
  expect(normalizeToolBaseUrl("https://relay.example.com/")).toBe("https://relay.example.com/v1");
  for (const url of [
    "http://example.com",
    "https://localhost/v1",
    "https://127.0.0.1",
    "https://user:key@example.com/v1",
    "https://example.com/v1?key=secret",
    "https://example.com/#fragment",
  ]) {
    expect(() => normalizeToolBaseUrl(url)).toThrow();
  }
  expect(parseToolConnectionConfig(JSON.stringify({ ...connection, source: "manual" }))).toEqual({
    ...connection,
    source: "manual",
  });
  expect(() =>
    parseToolConnectionConfig(
      JSON.stringify({ kind: "openrouter", source: "channel", channelId: "other" }),
    ),
  ).toThrow();
});

test("compatible relay receives its own bearer and prefixed tools path without fallback", async () => {
  const calls: string[] = [];
  const results = await searchToolService("release", {
    connection,
    resolveHostname: dns,
    fetchImpl: async (url, init) => {
      calls.push(String(url));
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer relay-key");
      expect(init?.redirect).toBe("error");
      return json({ results: [{ url: "https://example.com/source", title: "Source" }] });
    },
  });
  expect(calls).toEqual(["https://relay.example.com/api/v1/tools/search"]);
  expect(results).toHaveLength(1);
  let requests = 0;
  await expect(
    searchToolService("x", {
      connection,
      resolveHostname: dns,
      fetchImpl: async () => {
        requests++;
        return new Response("secret", { status: 404 });
      },
    }),
  ).rejects.toThrow("HTTP 404");
  expect(requests).toBe(1);
});

test("private DNS and aborted requests never send a credential", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return json({ results: [] });
  };
  await expect(
    searchToolService("x", { connection, resolveHostname: async () => ["10.0.0.1"], fetchImpl }),
  ).rejects.toThrow();
  await expect(
    searchToolService("x", {
      connection,
      resolveHostname: dns,
      signal: AbortSignal.abort(),
      fetchImpl,
    }),
  ).rejects.toThrow();
  expect(calls).toBe(0);
});

test("OpenRouter requests server tools and requires actual citations, never model prose", async () => {
  const openrouter = {
    kind: "openrouter" as const,
    baseUrl: "https://openrouter.ai/api/v1",
    apiKey: "router-key",
    model: "test/model",
  };
  const options = {
    connection: openrouter,
    resolveHostname: dns,
    fetchImpl: async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      expect(String(url)).toBe("https://openrouter.ai/api/v1/chat/completions");
      const body = JSON.parse(String(init?.body));
      expect(body.tools[0].type).toBe("openrouter:web_search");
      expect(body.tool_choice.type).toBe("openrouter:web_search");
      return json({
        choices: [
          {
            finish_reason: "stop",
            message: {
              content: "Generated prose",
              annotations: [
                {
                  type: "url_citation",
                  url_citation: {
                    url: "https://example.com/source",
                    title: "Source",
                    content: "Extracted evidence",
                  },
                },
              ],
            },
          },
        ],
      });
    },
  };
  expect((await searchToolService("release", options))[0].content).toBe("Extracted evidence");
  await expect(
    searchToolService("release", {
      ...options,
      fetchImpl: async () =>
        json({
          choices: [{ finish_reason: "stop", message: { content: "I searched", annotations: [] } }],
        }),
    }),
  ).rejects.toThrow("no_sources");
  await expect(
    fetchToolService("https://example.com/source", {
      ...options,
      fetchImpl: async () =>
        json({ choices: [{ finish_reason: "length", message: { content: "partial" } }] }),
    }),
  ).rejects.toThrow();
});

test("OpenRouter fetch bounds DNS validation and accepts only the requested canonical source", async () => {
  const connection = {
    kind: "openrouter" as const,
    baseUrl: "https://openrouter.ai/api/v1",
    apiKey: "router-only",
    model: "test/model",
  };
  let calls = 0;
  await expect(
    fetchToolService("https://example.com", {
      connection,
      timeoutMs: 5,
      resolveHostname: async () => new Promise<string[]>(() => {}),
      fetchImpl: async () => {
        calls++;
        return json({});
      },
    }),
  ).rejects.toThrow("timeout");
  expect(calls).toBe(0);
  const page = await fetchToolService("https://example.com#section", {
    connection,
    resolveHostname: dns,
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      expect(body.tools[0].parameters.allowed_domains).toEqual(["example.com"]);
      return json({
        choices: [
          {
            finish_reason: "stop",
            message: {
              annotations: [
                {
                  type: "url_citation",
                  url_citation: { url: "https://example.com/", content: "Original source" },
                },
              ],
            },
          },
        ],
      });
    },
  });
  expect(page.content).toBe("Original source");
});
