import { expect, test } from "bun:test";
import { NATIVE_SEARCH_BASE_URL, NATIVE_SEARCH_MODEL } from "../deepseek-native-search";
import { formatNativeSearchResult, searchDeepSeekNative } from "./deepseekNativeProvider";

const connection = {
  apiKey: "synthetic-native-key",
  baseUrl: NATIVE_SEARCH_BASE_URL,
  model: NATIVE_SEARCH_MODEL,
};
const fixture = () => ({
  status: "completed",
  error: null,
  incomplete_details: null,
  usage: { server_tool_use: { tool_search: 1, tool_fetch: 0 } },
  output: [
    {
      type: "reasoning",
      content: [{ type: "reasoning_text", text: "private-reasoning-never-forward" }],
    },
    {
      type: "web_search_call",
      status: "completed",
      id: "synthetic-search",
      encrypted_content: "private-state-never-forward",
    },
    {
      type: "message",
      role: "assistant",
      status: "completed",
      content: [
        {
          type: "output_text",
          text: "Source-backed synthetic summary.",
          annotations: [
            { type: "url_citation", url: "https://example.com/source", title: "Synthetic source" },
          ],
        },
      ],
    },
  ] as Array<Record<string, unknown>>,
});
const options = { connection, resolveHostname: async () => ["93.184.216.34"] };

test("native retrieval uses its dedicated official Responses credential and returns evidence without provider state", async () => {
  let calls = 0;
  const result = await searchDeepSeekNative("Synthetic documentation", {
    ...options,
    fetchImpl: async (url, init) => {
      calls++;
      expect(String(url)).toBe("https://api.deepseek.com/v1/responses");
      expect((init?.headers as Record<string, string>).Authorization).toBe(
        "Bearer synthetic-native-key",
      );
      expect(init?.redirect).toBe("error");
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe(NATIVE_SEARCH_MODEL);
      expect(body.tools).toEqual([{ type: "web_search" }]);
      expect(body.tool_choice).toBe("required");
      expect(body.store).toBe(false);
      return Response.json(fixture());
    },
  });
  expect(calls).toBe(1);
  expect(result.citations).toHaveLength(1);
  expect(result.summary).toBe("Source-backed synthetic summary.");
  const text = formatNativeSearchResult(result);
  expect(text.includes("model_generated_summary")).toBe(true);
  expect(text.includes("private-reasoning")).toBe(false);
  expect(text.includes("private-state")).toBe(false);
});

for (const condition of [
  "ordinary_answer",
  "no_successful_search",
  "no_sources",
  "private_source",
  "incomplete",
  "refusal",
] as const) {
  test(`native retrieval rejects ${condition} instead of trusting generated prose`, async () => {
    const payload = fixture();
    if (condition === "ordinary_answer")
      payload.output = payload.output.filter((item) => item.type !== "web_search_call");
    if (condition === "no_successful_search") payload.usage.server_tool_use.tool_search = 0;
    if (condition === "no_sources")
      (
        payload.output[2].content as Array<{ annotations: Array<Record<string, unknown>> }>
      )[0].annotations = [];
    if (condition === "private_source")
      (
        payload.output[2].content as Array<{ annotations: Array<Record<string, unknown>> }>
      )[0].annotations[0].url = "http://127.0.0.1/private";
    if (condition === "incomplete") payload.status = "incomplete";
    if (condition === "refusal")
      payload.output[2].content = [{ type: "refusal", refusal: "synthetic" }];
    let failed = false;
    try {
      await searchDeepSeekNative("Synthetic docs", {
        ...options,
        fetchImpl: async () => Response.json(payload),
      });
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
  });
}

test("native retrieval refuses unsupported model and nonofficial destination before sending a Key", async () => {
  let calls = 0;
  for (const invalid of [
    { ...connection, model: "deepseek-flash" },
    { ...connection, baseUrl: "https://relay.example.com/v1" },
  ]) {
    try {
      await searchDeepSeekNative("docs", {
        ...options,
        connection: invalid,
        fetchImpl: async () => {
          calls++;
          return Response.json(fixture());
        },
      });
    } catch {}
  }
  expect(calls).toBe(0);
});

test("native retrieval accepts structured search-call sources and never extracts prose URLs as evidence", async () => {
  const payload = fixture();
  payload.output[1].action = {
    sources: [{ url: "https://example.com/retrieved", title: "Retrieved source" }],
  };
  (
    payload.output[2].content as Array<{ annotations: Array<Record<string, unknown>> }>
  )[0].annotations = [];
  const result = await searchDeepSeekNative("docs", {
    ...options,
    fetchImpl: async () => Response.json(payload),
  });
  expect(result.citations[0].url).toBe("https://example.com/retrieved");
});

test("native verification has a bounded deadline and never retries failed requests", async () => {
  let calls = 0;
  try {
    await searchDeepSeekNative("docs", {
      ...options,
      timeoutMs: 5,
      fetchImpl: async () => {
        calls++;
        return new Promise<Response>(() => {});
      },
    });
  } catch (error) {
    expect((error as Error).message).toBe("timeout");
  }
  expect(calls).toBe(1);
  const controller = new AbortController();
  controller.abort();
  try {
    await searchDeepSeekNative("docs", {
      ...options,
      signal: controller.signal,
      fetchImpl: async () => {
        calls++;
        return Response.json(fixture());
      },
    });
  } catch {}
  expect(calls).toBe(1);
});

test("native model retrieval accepts bounded full queries beyond the standalone Search API's 128-character limit", async () => {
  const result = await searchDeepSeekNative("Synthetic official documentation ".repeat(8), {
    ...options,
    fetchImpl: async () => Response.json(fixture()),
  });
  expect(result.citations).toHaveLength(1);
});

test("the fixed official native endpoint works with fake-IP proxies, while the trust tag cannot exempt relay destinations", async () => {
  let calls = 0;
  await searchDeepSeekNative("docs", {
    ...options,
    resolveHostname: async () => ["198.18.0.1"],
    fetchImpl: async (url) => {
      calls++;
      expect(String(url)).toBe("https://api.deepseek.com/v1/responses");
      return Response.json(fixture());
    },
  });
  const { requestToolJson } = await import("./toolTransport");
  await expect(
    requestToolJson(
      "/responses",
      {},
      {
        connection: { ...connection, kind: "deepseek", baseUrl: "https://relay.example.com/v1" },
        trustedNativeEndpoint: true,
        resolveHostname: async () => ["127.0.0.1"],
        fetchImpl: async () => {
          calls++;
          return Response.json({});
        },
      },
    ),
  ).rejects.toThrow("unsafe_url");
  expect(calls).toBe(1);
});

test("documented optional response role does not discard an otherwise proven native search", async () => {
  const data = fixture();
  delete data.output[2].role;
  const result = await searchDeepSeekNative("docs", {
    ...options,
    fetchImpl: async () => Response.json(data),
  });
  expect(result.citations).toHaveLength(1);
});

test("an optional call status requires the completed response plus an explicit successful search count", async () => {
  const data = fixture();
  delete data.output[1].status;
  const accepted = await searchDeepSeekNative("docs", {
    ...options,
    fetchImpl: async () => Response.json(data),
  });
  expect(accepted.toolUsage.search).toBe(1);
  data.usage.server_tool_use.tool_search = 0;
  await expect(
    searchDeepSeekNative("docs", { ...options, fetchImpl: async () => Response.json(data) }),
  ).rejects.toThrow("native_search_not_executed");
});
