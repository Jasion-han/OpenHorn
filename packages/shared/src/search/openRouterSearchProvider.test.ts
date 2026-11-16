import { expect, test } from "bun:test";
import {
  OPENROUTER_SEARCH_BASE_URL,
  OPENROUTER_SEARCH_ENGINE,
  OPENROUTER_SEARCH_MODEL,
} from "../openrouter-search";
import { formatOpenRouterSearchResult, searchOpenRouter } from "./openRouterSearchProvider";
import { selectSearchProvider } from "./providerSelection";
import { requestToolJson } from "./toolTransport";

const connection = {
  apiKey: "synthetic-openrouter-key",
  baseUrl: OPENROUTER_SEARCH_BASE_URL,
  model: OPENROUTER_SEARCH_MODEL,
  engine: OPENROUTER_SEARCH_ENGINE,
} as const;
type Payload = {
  error?: unknown;
  status?: string;
  choices: Array<{
    finish_reason: string;
    error?: unknown;
    message: {
      role: string;
      content: string;
      refusal?: string;
      tool_calls?: unknown[];
      reasoning: string;
      reasoning_details: Array<{ signature: string }>;
      annotations: Array<{
        type: string;
        url_citation: { url: string; title: string; content: string };
      }>;
    };
  }>;
};
function payload(): Payload {
  return {
    choices: [
      {
        finish_reason: "stop",
        message: {
          role: "assistant",
          content: "Synthetic source-backed summary.",
          reasoning: "private-reasoning",
          reasoning_details: [{ signature: "private-signature" }],
          annotations: [
            {
              type: "url_citation",
              url_citation: {
                url: "https://example.com/docs",
                title: "Docs",
                content: "private-provider-state",
              },
            },
          ],
        },
      },
    ],
  };
}

test("OpenRouter Flash disables reasoning, favors latency and returns only public evidence", async () => {
  let calls = 0;
  const result = await searchOpenRouter("  Synthetic docs  ", {
    connection,
    resolveHostname: async () => {
      throw new Error("fake-IP DNS must not run");
    },
    fetchImpl: async (url, init) => {
      calls++;
      expect(String(url)).toBe("https://openrouter.ai/api/v1/chat/completions");
      expect(new Headers(init?.headers).get("Authorization")).toBe(
        "Bearer synthetic-openrouter-key",
      );
      expect(init?.redirect).toBe("error");
      const body = JSON.parse(String(init?.body));
      expect(body.tools).toEqual([
        {
          type: "openrouter:web_search",
          parameters: { engine: "exa", max_results: 3, max_uses: 1 },
        },
      ]);
      expect(body.tool_choice).toBe("auto");
      expect(body.max_tokens).toBe(2000);
      expect(body.stream).toBe(false);
      expect(body.provider).toEqual({ allow_fallbacks: false, sort: "latency" });
      expect(body.model).toBe(OPENROUTER_SEARCH_MODEL);
      expect(body.reasoning).toEqual({ enabled: false });
      return Response.json(payload());
    },
  });
  expect(calls).toBe(1);
  expect(result).toEqual({
    citations: [{ url: "https://example.com/docs", title: "Docs" }],
    summary: "Synthetic source-backed summary.",
  });
  const formatted = formatOpenRouterSearchResult(result);
  expect(formatted.includes("not original page text")).toBe(true);
  for (const secret of [
    connection.apiKey,
    "private-reasoning",
    "private-signature",
    "private-provider-state",
  ])
    expect(formatted.includes(secret)).toBe(false);
});

for (const [condition, mutate] of Object.entries({
  truncation: (p: Payload) => {
    p.choices[0].finish_reason = "length";
  },
  error: (p: Payload) => {
    p.error = { message: connection.apiKey };
  },
  choice_error: (p: Payload) => {
    p.choices[0].error = { message: "error" };
  },
  refusal: (p: Payload) => {
    p.choices[0].message.refusal = "refused";
  },
  tool_calls: (p: Payload) => {
    p.choices[0].message.tool_calls = [{ id: "pending" }];
  },
  wrong_role: (p: Payload) => {
    p.choices[0].message.role = "tool";
  },
  empty: (p: Payload) => {
    p.choices[0].message.content = " ";
  },
  too_long: (p: Payload) => {
    p.choices[0].message.content = "x".repeat(16001);
  },
  credential: (p: Payload) => {
    p.choices[0].message.content = connection.apiKey;
  },
  reasoning: (p: Payload) => {
    p.choices[0].message.content = "<think>private</think>";
  },
  incomplete: (p: Payload) => {
    p.status = "incomplete";
  },
  prose_url: (p: Payload) => {
    p.choices[0].message.annotations = [];
    p.choices[0].message.content = "See https://example.com/docs";
  },
  private_url: (p: Payload) => {
    p.choices[0].message.annotations[0].url_citation.url = "http://127.0.0.1/private";
  },
  signed_url: (p: Payload) => {
    p.choices[0].message.annotations[0].url_citation.url = "https://example.com/?signature=private";
  },
  wrong_annotation: (p: Payload) => {
    p.choices[0].message.annotations[0].type = "text";
  },
}))
  test(`OpenRouter rejects ${condition} with one request and no secret error`, async () => {
    const p = payload();
    mutate(p);
    let calls = 0,
      message = "";
    try {
      await searchOpenRouter("docs", {
        connection,
        fetchImpl: async () => {
          calls++;
          return Response.json(p);
        },
      });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(calls).toBe(1);
    expect(message.length > 0).toBe(true);
    expect(message.includes(connection.apiKey)).toBe(false);
  });

test("OpenRouter explicit selection never borrows Tavily, Jev, or tool credentials", () => {
  expect(
    selectSearchProvider({
      searchProvider: "openrouter",
      tavilyApiKey: "wrong",
      deepseekApiKey: "wrong",
      nativeSearchApiKey: "wrong",
    }),
  ).toEqual({ provider: "none", reason: "not_configured" });
  expect(
    selectSearchProvider({ searchProvider: "openrouter", openRouterSearchApiKey: "dedicated" }),
  ).toEqual({ provider: "openrouter", apiKey: "dedicated" });
});

test("one request is cancelable during fetch and body consumption and has a bounded deadline", async () => {
  for (const phase of ["fetch", "body", "timeout"]) {
    const controller = new AbortController();
    let calls = 0,
      message = "";
    try {
      await searchOpenRouter("docs", {
        connection,
        signal: controller.signal,
        timeoutMs: 10,
        fetchImpl: async () => {
          calls++;
          if (phase !== "timeout") queueMicrotask(() => controller.abort());
          if (phase === "body")
            return new Response(
              new ReadableStream({
                start(c) {
                  c.enqueue(new TextEncoder().encode('{"choices":'));
                },
              }),
            );
          return new Promise<Response>(() => {});
        },
      });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(calls).toBe(1);
    expect(message).toBe(phase === "timeout" ? "timeout" : "aborted");
  }
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  try {
    await searchOpenRouter("docs", {
      connection,
      signal: controller.signal,
      fetchImpl: async () => {
        calls++;
        return Response.json(payload());
      },
    });
  } catch {}
  expect(calls).toBe(0);
});

test("trust flag exempts only the exact official chat target; relay/path/targetUrl checks remain", async () => {
  let calls = 0;
  for (const [baseUrl, path, targetUrl] of [
    ["https://relay.example.com/v1", "/chat/completions", undefined],
    [OPENROUTER_SEARCH_BASE_URL, "/responses", undefined],
    [OPENROUTER_SEARCH_BASE_URL, "/chat/completions", "http://127.0.0.1/private"],
  ] as const) {
    let message = "";
    try {
      await requestToolJson(
        path,
        {},
        {
          connection: { ...connection, baseUrl, kind: "openrouter" },
          targetUrl,
          trustedOpenRouterEndpoint: true,
          resolveHostname: async () => ["198.18.0.1"],
          fetchImpl: async () => {
            calls++;
            return Response.json({});
          },
        },
      );
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe("unsafe_url");
  }
  expect(calls).toBe(0);
});

test("unsupported destination, model, or engine is rejected before any request", async () => {
  let calls = 0;
  for (const change of [
    { baseUrl: "https://relay.example.com/v1" },
    { model: "other" },
    { engine: "other" },
  ]) {
    try {
      await searchOpenRouter("docs", {
        connection: { ...connection, ...change } as typeof connection,
        fetchImpl: async () => {
          calls++;
          return Response.json(payload());
        },
      });
    } catch {}
  }
  expect(calls).toBe(0);
});

test("OpenRouter rejects HTTP failures and oversized declared or streamed responses without retry", async () => {
  for (const response of [
    new Response(connection.apiKey, { status: 429 }),
    new Response("{}", { headers: { "Content-Length": String(1024 * 1024 + 1) } }),
    new Response("x".repeat(1024 * 1024 + 1)),
  ]) {
    let calls = 0,
      message = "";
    try {
      await searchOpenRouter("docs", {
        connection,
        fetchImpl: async () => {
          calls++;
          return response;
        },
      });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(calls).toBe(1);
    expect(message === "HTTP 429" || message === "response_too_large").toBe(true);
    expect(message.includes(connection.apiKey)).toBe(false);
  }
});

test("Explicit Pro requests retain the saved model without the Flash reasoning override", async () => {
  await searchOpenRouter("docs", {
    connection: { ...connection, model: "deepseek/deepseek-v4-pro" },
    resolveHostname: async () => ["93.184.216.34"],
    fetchImpl: async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe("deepseek/deepseek-v4-pro");
      expect(body.reasoning).toBe(undefined);
      return Response.json(payload());
    },
  });
});
