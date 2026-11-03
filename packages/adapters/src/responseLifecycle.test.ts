import { expect, test } from "bun:test";
import { AnthropicAdapter, GoogleAdapter, OpenAIAdapter, type ProviderAdapter } from "./adapters";

const encoder = new TextEncoder();
const options = { model: "fixture", messages: [{ role: "user" as const, content: "fixture" }] };
const openaiWire = 'data: {"choices":[{"delta":{"content":"hello"}}]}\n\ndata: [DONE]\n\n';

async function withFetch(handler: (init?: RequestInit) => Response, run: () => Promise<void>) {
  const previous = globalThis.fetch;
  globalThis.fetch = (async (_input, init) => handler(init)) as typeof fetch;
  try {
    await run();
  } finally {
    globalThis.fetch = previous;
  }
}

async function drain(adapter: ProviderAdapter) {
  let text = "";
  for await (const part of adapter.chatStream(options)) text += part;
  return text;
}

function fragmentedResponse(chunks: Uint8Array[], contentType: string) {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    }),
    { headers: { "content-type": contentType } },
  );
}

test("OpenAI Chat and Agent sniff initial SSE prefixes across arbitrary byte chunks", async () => {
  for (const contentType of ["text/event-stream", "application/json", "text/plain"]) {
    for (const prefix of ["", " ", "\n", "\uFEFF"]) {
      const bytes = encoder.encode(prefix + openaiWire);
      for (let split = 1; split <= prefix.length + 5; split++) {
        const response = () =>
          fragmentedResponse([bytes.slice(0, split), bytes.slice(split)], contentType);
        await withFetch(response, async () => {
          expect(await drain(new OpenAIAdapter("synthetic-only"))).toBe("hello");
          let text = "";
          for await (const event of new OpenAIAdapter("synthetic-only").runToolCallingTurnStream({
            ...options,
            tools: [],
          })) {
            if (event.type === "text_delta") text += event.content;
            if (event.type === "done") expect(event.result.text).toBe("hello");
          }
          expect(text).toBe("hello");
        });
      }
    }
  }
});

test("OpenAI format sniff still accepts fragmented JSON and plain-text fallbacks", async () => {
  for (const [wire, expected] of [
    [JSON.stringify({ choices: [{ message: { content: "json fallback" } }] }), "json fallback"],
    ["daily plain response", "daily plain response"],
  ]) {
    await withFetch(
      () =>
        fragmentedResponse(
          [encoder.encode(wire.slice(0, 2)), encoder.encode(wire.slice(2))],
          "application/json",
        ),
      async () => expect(await drain(new OpenAIAdapter("synthetic-only"))).toBe(expected),
    );
  }
});

test("OpenAI keeps JSON fallback when a gateway mislabels its body as SSE", async () => {
  const bytes = encoder.encode(
    JSON.stringify({ choices: [{ message: { content: "json fallback" } }] }),
  );
  for (const split of [1, 2, 5]) {
    await withFetch(
      () => fragmentedResponse([bytes.slice(0, split), bytes.slice(split)], "text/event-stream"),
      async () => {
        expect(await drain(new OpenAIAdapter("synthetic-only"))).toBe("json fallback");
        let text = "";
        for await (const event of new OpenAIAdapter("synthetic-only").runToolCallingTurnStream({
          ...options,
          tools: [],
        })) {
          if (event.type === "done") text = event.result.text;
        }
        expect(text).toBe("json fallback");
      },
    );
  }
});

const protocols = [
  {
    name: "OpenAI",
    adapter: () => new OpenAIAdapter("synthetic-only"),
    frame: 'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n',
  },
  {
    name: "Anthropic",
    adapter: () => new AnthropicAdapter("synthetic-only"),
    frame: 'data: {"type":"content_block_delta","delta":{"text":"hello"}}\n\n',
  },
  {
    name: "Google",
    adapter: () => new GoogleAdapter("synthetic-only"),
    frame: 'data: {"candidates":[{"content":{"parts":[{"text":"hello"}]}}]}\n\n',
  },
];

for (const protocol of protocols) {
  test(`${protocol.name} releases and cancels its reader when the consumer returns`, async () => {
    let canceled = 0;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(protocol.frame));
        },
        cancel() {
          canceled++;
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
    await withFetch(
      () => response,
      async () => {
        const stream = protocol.adapter().chatStream(options);
        expect((await stream.next()).value).toBe("hello");
        await stream.return(undefined);
        expect(response.body?.locked).toBe(false);
        expect(canceled).toBe(1);
      },
    );
  });
}

test("OpenAI DONE cancels an unfinished body and releases its lock", async () => {
  let canceled = 0;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      },
      cancel() {
        canceled++;
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
  await withFetch(
    () => response,
    async () => {
      expect(await drain(new OpenAIAdapter("synthetic-only"))).toBe("");
      expect(response.body?.locked).toBe(false);
      expect(canceled).toBe(1);
    },
  );
});

test("OpenAI streamed Agent releases its reader when the consumer returns", async () => {
  let canceled = 0;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(protocols[0].frame));
      },
      cancel() {
        canceled++;
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
  await withFetch(
    () => response,
    async () => {
      const stream = new OpenAIAdapter("synthetic-only").runToolCallingTurnStream({
        ...options,
        tools: [],
      });
      expect((await stream.next()).value).toMatchObject({ type: "text_delta", content: "hello" });
      await stream.return(undefined);
      expect(response.body?.locked).toBe(false);
      expect(canceled).toBe(1);
    },
  );
});

for (const protocol of protocols) {
  for (const streaming of [true, false]) {
    test(`${protocol.name} ${streaming ? "stream" : "chat"} honors Stop while reading an error body`, async () => {
      let release!: () => void;
      let readStarted!: () => void;
      const reading = new Promise<void>((resolve) => {
        readStarted = resolve;
      });
      const controller = new AbortController();
      let produced = false;
      await withFetch(
        (init) =>
          new Response(
            new ReadableStream<Uint8Array>(
              {
                start(body) {
                  release = () => {
                    try {
                      body.close();
                    } catch {}
                  };
                  init?.signal?.addEventListener("abort", () => body.error(init.signal?.reason), {
                    once: true,
                  });
                },
                pull(body) {
                  if (!produced) {
                    produced = true;
                    body.enqueue(encoder.encode("error prefix"));
                    readStarted();
                  }
                },
              },
              { highWaterMark: 0 },
            ),
            { status: 400 },
          ),
        async () => {
          const adapter = protocol.adapter();
          const run = (async () => {
            try {
              if (streaming)
                for await (const _ of adapter.chatStream({
                  ...options,
                  signal: controller.signal,
                })) {
                }
              else await adapter.chat({ ...options, signal: controller.signal });
              return "success";
            } catch (error) {
              return error instanceof Error ? error.name : "unknown";
            }
          })();
          await reading;
          controller.abort(new DOMException("synthetic Stop", "AbortError"));
          const state = await Promise.race([run, Bun.sleep(40).then(() => "pending")]);
          release();
          await run;
          expect(state).toBe("AbortError");
        },
      );
    });
  }
}

test("provider error diagnostics stop reading after a bounded prefix", async () => {
  let release!: () => void;
  let canceled = 0;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("x".repeat(128 * 1024)));
        release = () => {
          try {
            controller.close();
          } catch {}
        };
      },
      cancel() {
        canceled++;
      },
    }),
    { status: 400 },
  );
  await withFetch(
    () => response,
    async () => {
      const run = drain(new OpenAIAdapter("synthetic-only")).catch((error: Error) => error.message);
      const state = await Promise.race([
        run.then(() => "settled"),
        Bun.sleep(40).then(() => "pending"),
      ]);
      release();
      const message = await run;
      expect(state).toBe("settled");
      expect(canceled).toBe(1);
      expect(response.body?.locked).toBe(false);
      expect(message.length < 900).toBe(true);
    },
  );
});

for (const protocol of protocols) {
  for (const mode of ["tool Stop", "request deadline"] as const) {
    test(`${protocol.name} error response remains protected during ${mode}`, async () => {
      let release!: () => void;
      let began!: () => void;
      let produced = false;
      const reading = new Promise<void>((resolve) => {
        began = resolve;
      });
      const controller = new AbortController();
      await withFetch(
        (init) =>
          new Response(
            new ReadableStream<Uint8Array>(
              {
                start(body) {
                  release = () => {
                    try {
                      body.close();
                    } catch {}
                  };
                  init?.signal?.addEventListener("abort", () => body.error(init.signal?.reason), {
                    once: true,
                  });
                },
                pull(body) {
                  if (!produced) {
                    produced = true;
                    body.enqueue(encoder.encode("error prefix"));
                    began();
                  }
                },
              },
              { highWaterMark: 0 },
            ),
            { status: 400 },
          ),
        async () => {
          const run = (async () => {
            try {
              await protocol.adapter().runToolCallingTurn({
                ...options,
                tools: [],
                signal: controller.signal,
                requestTimeoutMs: mode === "request deadline" ? 10 : 1000,
              });
              return "success";
            } catch (error) {
              return error instanceof Error ? error.name : "unknown";
            }
          })();
          await reading;
          if (mode === "tool Stop")
            controller.abort(new DOMException("synthetic Stop", "AbortError"));
          const state = await Promise.race([run, Bun.sleep(40).then(() => "pending")]);
          release();
          await run;
          expect(state).toBe(mode === "tool Stop" ? "AbortError" : "TimeoutError");
        },
      );
    });
  }
}

test("OpenAI streamed Agent honors request timeout while reading an error body", async () => {
  let release!: () => void;
  await withFetch(
    (init) =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(body) {
            body.enqueue(encoder.encode("error prefix"));
            release = () => {
              try {
                body.close();
              } catch {}
            };
            init?.signal?.addEventListener("abort", () => body.error(init.signal?.reason), {
              once: true,
            });
          },
        }),
        { status: 400 },
      ),
    async () => {
      const run = (async () => {
        try {
          for await (const _ of new OpenAIAdapter("synthetic-only").runToolCallingTurnStream({
            ...options,
            tools: [],
            requestTimeoutMs: 10,
          })) {
          }
          return "success";
        } catch (error) {
          return error instanceof Error ? error.name : "unknown";
        }
      })();
      const state = await Promise.race([run, Bun.sleep(40).then(() => "pending")]);
      release();
      await run;
      expect(state).toBe("TimeoutError");
    },
  );
});

test("successful JSON responses are not truncated by the error diagnostic byte limit", async () => {
  const content = "x".repeat(100_000);
  await withFetch(
    () => Response.json({ choices: [{ message: { content } }] }),
    async () => {
      expect((await new OpenAIAdapter("synthetic-only").chat(options)).content).toBe(content);
    },
  );
});

test("reader cleanup does not await an unresponsive cancel hook", async () => {
  let canceled = 0;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(body) {
        body.enqueue(encoder.encode("data: [DONE]\n\n"));
      },
      cancel() {
        canceled++;
        return new Promise(() => {});
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
  await withFetch(
    () => response,
    async () => {
      const result = await Promise.race([
        drain(new OpenAIAdapter("synthetic-only")).then(() => "done"),
        Bun.sleep(40).then(() => "pending"),
      ]);
      expect(result).toBe("done");
      expect(canceled).toBe(1);
      expect(response.body?.locked).toBe(false);
    },
  );
});

test("retry discards the previous error body without waiting for its cancellation hook", async () => {
  let requests = 0;
  let canceled = 0;
  const unavailable = new Response(
    new ReadableStream<Uint8Array>({
      start(body) {
        body.enqueue(encoder.encode("temporary failure"));
      },
      cancel() {
        canceled++;
        return new Promise(() => {});
      },
    }),
    { status: 503 },
  );
  await withFetch(
    () => {
      requests++;
      return requests === 1
        ? unavailable
        : Response.json({ choices: [{ message: { content: "recovered" } }] });
    },
    async () => {
      expect((await new OpenAIAdapter("synthetic-only").chat(options)).content).toBe("recovered");
      expect(requests).toBe(2);
      expect(canceled).toBe(1);
    },
  );
});

for (const mode of ["Stop", "deadline"] as const) {
  test(`retry backoff honors ${mode} and starts no subsequent request`, async () => {
    const originalTimeout = globalThis.setTimeout;
    const timers: Array<ReturnType<typeof setTimeout>> = [];
    let releaseBackoff: (() => void) | undefined;
    let entered!: () => void;
    const backoff = new Promise<void>((resolve) => {
      entered = resolve;
    });
    globalThis.setTimeout = ((...args: Parameters<typeof originalTimeout>) => {
      const [callback, delay, ...rest] = args;
      if (
        typeof delay === "number" &&
        delay >= 500 &&
        delay <= 625 &&
        typeof callback === "function"
      ) {
        const timer = originalTimeout(() => {}, 30_000);
        timers.push(timer);
        releaseBackoff = () => {
          clearTimeout(timer);
          callback(...rest);
        };
        entered();
        return timer;
      }
      return originalTimeout(...args);
    }) as typeof setTimeout;
    const controller = new AbortController();
    let requests = 0;
    try {
      await withFetch(
        (init) => {
          requests++;
          if (init?.signal?.aborted) throw init.signal.reason;
          return new Response("temporary failure", { status: 503 });
        },
        async () => {
          const run = new OpenAIAdapter("synthetic-only")
            .chat({
              ...options,
              signal: controller.signal,
              requestTimeoutMs: mode === "deadline" ? 10 : 1000,
            })
            .then(
              () => "success",
              (error: Error) => error.name,
            );
          await backoff;
          if (mode === "Stop") controller.abort(new DOMException("synthetic Stop", "AbortError"));
          const state = await Promise.race([run, Bun.sleep(40).then(() => "pending")]);
          releaseBackoff?.();
          await run;
          expect(state).toBe(mode === "Stop" ? "AbortError" : "TimeoutError");
          expect(requests).toBe(1);
        },
      );
    } finally {
      globalThis.setTimeout = originalTimeout;
      for (const timer of timers) clearTimeout(timer);
      releaseBackoff?.();
    }
  });
}
