import { describe, expect, test } from "bun:test";
import { EMBEDDING_DIMENSIONS, generateEmbeddings } from "./embeddingService";

const vector = (value: number) => Array(EMBEDDING_DIMENSIONS).fill(value) as number[];
const originalFetch = globalThis.fetch;
async function withResponse(data: unknown, run: () => Promise<void>) {
  globalThis.fetch = (async () => Response.json(data)) as unknown as typeof fetch;
  try {
    await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

describe("embedding response integrity", () => {
  test("assigns out-of-order indexed vectors to the corresponding input", async () => {
    await withResponse(
      {
        data: [
          { index: 1, embedding: vector(2) },
          { index: 0, embedding: vector(1) },
        ],
      },
      async () => {
        const result = await generateEmbeddings(["first", "second"], "synthetic");
        expect(result.map((row) => row[0])).toEqual([1, 2]);
      },
    );
  });

  test("accepts compatible providers omitting every index", async () => {
    await withResponse({ data: [{ embedding: vector(1) }] }, async () => {
      expect((await generateEmbeddings(["one"], "synthetic"))[0]).toEqual(vector(1));
    });
  });

  for (const [name, data] of Object.entries({
    missing: {},
    count: { data: [] },
    dimensions: { data: [{ embedding: [1] }] },
    nonfinite: { data: [{ embedding: vector(Number.NaN) }] },
    duplicate: {
      data: [
        { index: 0, embedding: vector(1) },
        { index: 0, embedding: vector(2) },
      ],
    },
    mixed: { data: [{ index: 0, embedding: vector(1) }, { embedding: vector(2) }] },
    range: { data: [{ index: 2, embedding: vector(1) }] },
  })) {
    test(`rejects ${name} response without producing partial vectors`, async () => {
      await withResponse(data, async () => {
        let rejected = false;
        try {
          await generateEmbeddings(
            name === "duplicate" || name === "mixed" ? ["a", "b"] : ["a"],
            "synthetic",
          );
        } catch {
          rejected = true;
        }
        expect(rejected).toBe(true);
      });
    });
  }
});

test("timeout aborts the upstream HTTP request", async () => {
  let aborted = false;
  const fetchImpl = ((_url: unknown, init: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => {
        aborted = true;
        reject(init.signal?.reason);
      });
    })) as unknown as typeof fetch;
  let name = "";
  try {
    await generateEmbeddings(["a"], "synthetic", undefined, { timeoutMs: 5, fetchImpl });
  } catch (error) {
    name = (error as Error).name;
  }
  expect(aborted).toBe(true);
  expect(name).toBe("TimeoutError");
});

test("caller cancellation propagates and already-cancelled input never starts fetch", async () => {
  const controller = new AbortController();
  let calls = 0;
  const fetchImpl = ((_url: unknown, init: RequestInit) => {
    calls++;
    return new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
    });
  }) as unknown as typeof fetch;
  const request = generateEmbeddings(["a"], "synthetic", undefined, {
    signal: controller.signal,
    fetchImpl,
  });
  controller.abort();
  let rejected = false;
  try {
    await request;
  } catch {
    rejected = true;
  }
  expect(rejected).toBe(true);
  try {
    await generateEmbeddings(["a"], "synthetic", undefined, {
      signal: controller.signal,
      fetchImpl,
    });
  } catch {}
  expect(calls).toBe(1);
});

test("timeout remains active while reading a stalled response body", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"data":'));
          },
        }),
        { headers: { "Content-Type": "application/json" } },
      ),
  });
  let rejected = false;
  try {
    await generateEmbeddings(["a"], "synthetic", `http://127.0.0.1:${server.port}`, {
      timeoutMs: 50,
    });
  } catch {
    rejected = true;
  } finally {
    server.stop(true);
  }
  expect(rejected).toBe(true);
});
