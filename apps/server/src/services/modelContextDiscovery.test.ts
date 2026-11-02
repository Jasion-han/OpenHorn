import { expect, test } from "bun:test";
import {
  CONTEXT_METADATA_TTL_MS,
  fetchModelDirectory,
  loadContextCatalog,
  loadOpenRouterModelContext,
  matchContextCatalog,
  parseContextCatalog,
  parseDirectoryContext,
  resetContextDiscoveryCaches,
} from "./modelContextDiscovery";

async function withFetch(
  handler: (url: URL, init?: RequestInit) => Promise<Response> | Response,
  run: () => Promise<void>,
) {
  const previous = globalThis.fetch;
  resetContextDiscoveryCaches();
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) =>
    handler(
      new URL(input instanceof Request ? input.url : String(input)),
      init,
    )) as unknown as typeof fetch;
  try {
    await run();
  } finally {
    globalThis.fetch = previous;
    resetContextDiscoveryCaches();
  }
}

const catalogFixture = {
  "openai/gpt-6-astra": {
    id: "gpt-6-astra",
    limit: { context: 1_050_000, input: 922_000, output: 128_000 },
  },
  "google/gemini-2.5-pro": { id: "gemini-2.5-pro", limit: { context: 1_048_576, output: 65_536 } },
};

test("provider directory formats retain separate context, input and output limits", () => {
  expect(
    parseDirectoryContext(
      {
        context_length: 2_000_000,
        top_provider: { context_length: 1_000_000, max_completion_tokens: 1024 },
      },
      "openai",
      10,
    ),
  ).toEqual({ contextWindow: 1_000_000, maxOutputTokens: 1024, source: "channel", fetchedAt: 10 });
  expect(
    parseDirectoryContext(
      { max_model_len: 32_768, max_input_tokens: 24_000, max_output_tokens: 512 },
      "openai",
      10,
    ),
  ).toEqual({
    contextWindow: 32_768,
    maxInputTokens: 24_000,
    maxOutputTokens: 512,
    source: "channel",
    fetchedAt: 10,
  });
  expect(
    parseDirectoryContext({ inputTokenLimit: 1_048_576, outputTokenLimit: 8192 }, "google", 10),
  ).toEqual({
    contextWindow: 1_048_576,
    maxInputTokens: 1_048_576,
    maxOutputTokens: 8192,
    inputLimitOnly: true,
    source: "channel",
    fetchedAt: 10,
  });
  expect(
    parseDirectoryContext({ max_input_tokens: 200_000, max_tokens: 1024 }, "anthropic", 10),
  ).toEqual({
    contextWindow: 200_000,
    maxInputTokens: 200_000,
    maxOutputTokens: 1024,
    inputLimitOnly: true,
    source: "channel",
    fetchedAt: 10,
  });
  for (const value of [
    { context_length: "1000000" },
    { context_window: 0 },
    { context_window: -1 },
    { context_window: Number.POSITIVE_INFINITY },
    { max_tokens: 8192 },
    { context_length: 16384, max_output_tokens: "1024" },
    { context_length: 16384, max_output_tokens: 0 },
  ])
    expect(parseDirectoryContext(value, "anthropic")).toBe(null);
});

test("catalog matching uses exact namespaces or an unambiguous model ID, never fuzzy aliases", () => {
  const parsed = parseContextCatalog(catalogFixture, 12);
  expect(matchContextCatalog(parsed, "openai/gpt-6-astra")?.maxInputTokens).toBe(922_000);
  expect(matchContextCatalog(parsed, "gpt-6-astra", "openai")?.contextWindow).toBe(1_050_000);
  expect(matchContextCatalog(parsed, "gemini-2.5-pro")?.contextWindow).toBe(1_048_576);
  expect(matchContextCatalog(parsed, "my-gpt-6-astra-alias")).toBe(null);
  expect(matchContextCatalog(parsed, "gpt-6-astra-2099-01-01")).toBe(null);
  const collision = parseContextCatalog({
    a: { models: { same: { id: "same", limit: { context: 8192 } } } },
    b: { models: { same: { id: "same", limit: { context: 32768 } } } },
  });
  expect(matchContextCatalog(collision, "same")).toBe(null);
  expect(matchContextCatalog(collision, "same", "a")?.contextWindow).toBe(8192);
});

test("only Google's models/ prefix is normalized; compatible IDs remain byte-for-byte", async () => {
  await withFetch(
    () =>
      Response.json({
        data: [{ id: "models/llama", context_window: 32768 }],
        models: [{ name: "models/gemini", inputTokenLimit: 32768 }],
      }),
    async () => {
      expect(
        (
          await fetchModelDirectory({
            protocol: "openai",
            url: "https://fixture.local/models",
            headers: {},
          })
        )[0]?.modelId,
      ).toBe("models/llama");
      expect(
        (
          await fetchModelDirectory({
            protocol: "google",
            url: "https://fixture.local/v1beta/models",
            headers: {},
          })
        )[0]?.modelId,
      ).toBe("gemini");
    },
  );
});

test("Google and Anthropic model pagination accumulate every page with a bounded shared signal", async () => {
  const requests: Array<{ url: URL; init?: RequestInit }> = [];
  await withFetch(
    (url, init) => {
      requests.push({ url, init });
      if (url.pathname.includes("google"))
        return Response.json(
          url.searchParams.has("pageToken")
            ? { models: [{ name: "models/g2", inputTokenLimit: 65536 }] }
            : { models: [{ name: "models/g1", inputTokenLimit: 32768 }], nextPageToken: "next" },
        );
      return Response.json(
        url.searchParams.has("after_id")
          ? { data: [{ id: "a2", max_input_tokens: 65536 }], has_more: false }
          : { data: [{ id: "a1", max_input_tokens: 32768 }], has_more: true, last_id: "a1" },
      );
    },
    async () => {
      expect(
        (
          await fetchModelDirectory({
            protocol: "google",
            url: "https://fixture.local/google/models",
            headers: { "x-goog-api-key": "fixture-secret" },
          })
        ).map((model) => model.modelId),
      ).toEqual(["g1", "g2"]);
      expect(
        (
          await fetchModelDirectory({
            protocol: "anthropic",
            url: "https://fixture.local/anthropic/models",
            headers: { "x-api-key": "fixture-secret" },
          })
        ).map((model) => model.modelId),
      ).toEqual(["a1", "a2"]);
      expect(requests[0]?.init?.signal).toBe(requests[1]?.init?.signal);
      expect(requests[2]?.init?.signal).toBe(requests[3]?.init?.signal);
      expect(requests.every((request) => request.init?.redirect === "error")).toBe(true);
    },
  );
});

test("foreign pagination and incomplete later pages fail instead of returning an authoritative partial list", async () => {
  let calls = 0;
  await withFetch(
    () => {
      calls++;
      return Response.json({ data: [{ id: "m" }], next: "https://foreign.local/models" });
    },
    async () => {
      await expect(
        fetchModelDirectory({
          protocol: "openai",
          url: "https://fixture.local/models",
          headers: { Authorization: "Bearer fixture-secret" },
        }),
      ).rejects.toThrow("Foreign");
      expect(calls).toBe(1);
    },
  );
  await withFetch(
    (url) =>
      url.searchParams.has("after")
        ? new Response("unavailable", { status: 503 })
        : Response.json({ data: [{ id: "m" }], has_more: true }),
    async () => {
      await expect(
        fetchModelDirectory({
          protocol: "openai",
          url: "https://fixture.local/models",
          headers: {},
        }),
      ).rejects.toThrow("503");
    },
  );
});

test("directory byte and pagination limits reject oversized or endlessly paginated responses", async () => {
  await withFetch(
    () => new Response("{}", { headers: { "content-length": "999999999" } }),
    async () => {
      await expect(
        fetchModelDirectory({
          protocol: "openai",
          url: "https://fixture.local/models",
          headers: {},
        }),
      ).rejects.toThrow("too large");
    },
  );
  let calls = 0;
  await withFetch(
    () => Response.json({ data: [{ id: `m${++calls}` }], has_more: true }),
    async () => {
      await expect(
        fetchModelDirectory({
          protocol: "openai",
          url: "https://fixture.local/models",
          headers: {},
        }),
      ).rejects.toThrow("pagination limit");
      expect(calls).toBe(20);
    },
  );
});

test("catalog reads are single-flight and cached, carry no provider credentials, and preserve good data after failure", async () => {
  let calls = 0;
  let fail = false;
  const previousNow = Date.now;
  let now = previousNow();
  Date.now = () => now;
  try {
    await withFetch(
      (_url, init) => {
        calls++;
        const headers = new Headers(init?.headers);
        expect(headers.has("authorization")).toBe(false);
        expect(headers.has("x-api-key")).toBe(false);
        expect(headers.get("accept")).toBe("application/json");
        return fail ? new Response("offline", { status: 503 }) : Response.json(catalogFixture);
      },
      async () => {
        const first = await Promise.all(Array.from({ length: 8 }, () => loadContextCatalog()));
        expect(calls).toBe(1);
        expect(first.every((value) => value.length === 2)).toBe(true);
        await loadContextCatalog();
        expect(calls).toBe(1);
        now += CONTEXT_METADATA_TTL_MS + 1;
        fail = true;
        expect((await loadContextCatalog()).length).toBe(2);
        expect(calls).toBe(2);
        await loadContextCatalog();
        expect(calls).toBe(2);
      },
    );
  } finally {
    Date.now = previousNow;
  }
});

test("failed initial catalog retrieval backs off and retries, including synchronously throwing fetch guards", async () => {
  let calls = 0;
  const previousNow = Date.now;
  let now = previousNow();
  Date.now = () => now;
  try {
    await withFetch(
      () => {
        if (++calls === 1) throw new Error("offline");
        return Response.json(catalogFixture);
      },
      async () => {
        expect((await loadContextCatalog()).length).toBe(0);
        await loadContextCatalog();
        expect(calls).toBe(1);
        now += 60_001;
        expect((await loadContextCatalog()).length).toBe(2);
        expect(calls).toBe(2);
      },
    );
  } finally {
    Date.now = previousNow;
  }
});

test("selected OpenRouter endpoint limits are cached and conservative across heterogeneous routes", async () => {
  let calls = 0;
  await withFetch(
    (url, init) => {
      calls++;
      expect(url.href).toBe("https://openrouter.ai/api/v1/models/openai/gpt-6-astra/endpoints");
      expect(new Headers(init?.headers).has("authorization")).toBe(false);
      return Response.json({
        data: {
          endpoints: [
            {
              context_length: 1_050_000,
              max_prompt_tokens: 922_000,
              max_completion_tokens: 128_000,
            },
            {
              context_length: 1_000_000,
              max_prompt_tokens: 900_000,
              max_completion_tokens: 65_536,
            },
          ],
        },
      });
    },
    async () => {
      const metadata = await loadOpenRouterModelContext("openai/gpt-6-astra");
      expect(metadata?.contextWindow).toBe(1_000_000);
      expect(metadata?.maxInputTokens).toBe(900_000);
      expect(metadata?.maxOutputTokens).toBe(65_536);
      await loadOpenRouterModelContext("openai/gpt-6-astra");
      expect(calls).toBe(1);
    },
  );
});

test("invalid nonempty model directories cannot be mistaken for a valid empty list", async () => {
  await withFetch(
    () => Response.json({ data: [{ context_window: 32768 }] }),
    async () => {
      await expect(
        fetchModelDirectory({
          protocol: "openai",
          url: "https://fixture.local/models",
          headers: {},
        }),
      ).rejects.toThrow("identifier");
    },
  );
});

test("directory fetches abort within their bounded metadata deadline", async () => {
  await withFetch(
    (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        if (init?.signal?.aborted) reject(init.signal.reason);
        else
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
            once: true,
          });
      }),
    async () => {
      await expect(
        fetchModelDirectory(
          {
            protocol: "openai",
            url: "https://fixture.local/models",
            headers: {},
          },
          { timeoutMs: 25 },
        ),
      ).rejects.toThrow();
    },
  );
});

test("explicit catalog refresh bypasses TTL while subsequent lazy reads use the refreshed cache", async () => {
  let calls = 0,
    context = 32768;
  await withFetch(
    () => {
      calls++;
      return Response.json({ "fixture/m": { id: "m", limit: { context } } });
    },
    async () => {
      expect(matchContextCatalog(await loadContextCatalog(), "fixture/m")?.contextWindow).toBe(
        32768,
      );
      context = 131072;
      const results = await Promise.all([
        loadContextCatalog({ force: true }),
        loadContextCatalog({ force: true }),
      ]);
      expect(
        results.every(
          (entries) => matchContextCatalog(entries, "fixture/m")?.contextWindow === 131072,
        ),
      ).toBe(true);
      expect(calls).toBe(2);
      expect(matchContextCatalog(await loadContextCatalog(), "fixture/m")?.contextWindow).toBe(
        131072,
      );
      expect(calls).toBe(2);
    },
  );
});
