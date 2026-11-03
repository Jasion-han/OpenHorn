import { expect, test } from "bun:test";
import type { ChatStreamEvent } from "../types/chat";
import { readSseStream, readTypedSseStream } from "./sse";

async function failure(run: () => Promise<void>) {
  try {
    await run();
    return null;
  } catch (error) {
    return error;
  }
}

for (const body of [
  "",
  'data: {"type":"delta","content":"partial answer"}\n\n',
  'data: {"type":"done"',
]) {
  test(`Chat EOF without a terminal is an interruption, preserving received deltas (${body.length})`, async () => {
    const response = new Response(body);
    const events: ChatStreamEvent[] = [];
    const error = await failure(() => readSseStream(response, (event) => events.push(event)));
    expect(error instanceof Error).toBe(true);
    expect(error instanceof Error && error.message.length > 0).toBe(true);
    expect(events.some((event) => event.type === "delta")).toBe(body.includes("partial answer"));
    expect(response.body?.locked).toBe(false);
  });
}

for (const type of ["done", "error"]) {
  test(`Chat ${type} remains a delivered terminal, not a transport interruption`, async () => {
    const response = new Response(`data: {"type":"${type}","message":"fixture"}\n\n`);
    const events: ChatStreamEvent[] = [];
    expect(await failure(() => readSseStream(response, (event) => events.push(event)))).toBe(null);
    expect(events.map((event) => event.type)).toEqual([type]);
    expect(response.body?.locked).toBe(false);
  });
}

test("UTF8 split chunks and a final terminal frame without newline are preserved", async () => {
  const bytes = new TextEncoder().encode(
    'data: {"type":"delta","content":"你好🙂"}\n\ndata: {"type":"done"}',
  );
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (let index = 0; index < bytes.length; index++)
          controller.enqueue(bytes.slice(index, index + 1));
        controller.close();
      },
    }),
  );
  const events: ChatStreamEvent[] = [];
  await readSseStream(response, (event) => events.push(event));
  expect(events).toEqual([{ type: "delta", content: "你好🙂" }, { type: "done" }]);
  expect(response.body?.locked).toBe(false);
});

test("the generic typed SSE reader accepts protocols without Chat terminal events", async () => {
  const response = new Response('data: {"type":"progress","value":2}\n\n');
  const events: unknown[] = [];
  await readTypedSseStream(response, (event) => events.push(event));
  expect(events).toEqual([{ type: "progress", value: 2 }]);
  expect(response.body?.locked).toBe(false);
});

test("a callback failure cancels its source and releases the reader without replacing the error", async () => {
  let canceled = 0;
  const cause = new Error("fixture callback failure");
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode('data: {"type":"delta","content":"partial"}\n\n'),
        );
      },
      cancel() {
        canceled++;
        throw new Error("fixture cleanup failure");
      },
    }),
  );
  expect(
    await failure(() =>
      readSseStream(response, () => {
        throw cause;
      }),
    ),
  ).toBe(cause);
  expect(canceled).toBe(1);
  expect(response.body?.locked).toBe(false);
});

test("a read failure releases the reader and preserves the original transport error", async () => {
  const cause = new Error("fixture transport failure");
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(cause);
      },
    }),
  );
  expect(await failure(() => readSseStream(response, () => {}))).toBe(cause);
  expect(response.body?.locked).toBe(false);
});
