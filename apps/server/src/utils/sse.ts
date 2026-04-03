export type SseEvent = {
  type: string;
  [key: string]: unknown;
};

export type SseContext = {
  abortController: AbortController;
  signal: AbortSignal;
};

export function formatSseEvent(event: SseEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

export function createSseStream(
  handler: (send: (event: SseEvent) => void, ctx: SseContext) => Promise<void>,
): ReadableStream {
  const encoder = new TextEncoder();
  const abortController = new AbortController();
  const ctx: SseContext = { abortController, signal: abortController.signal };
  const pendingChunks: Uint8Array[] = [];
  let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
  let closed = false;
  let shouldCloseOnStart = false;

  const send = (event: SseEvent) => {
    if (closed) return;
    const chunk = encoder.encode(formatSseEvent(event));
    if (!streamController) {
      pendingChunks.push(chunk);
      return;
    }
    try {
      streamController.enqueue(chunk);
    } catch {
      closed = true;
      try {
        abortController.abort("client_disconnect");
      } catch {
        // ignore
      }
    }
  };

  void (async () => {
    try {
      await handler(send, ctx);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Error";
      send({
        type: "error",
        message,
        content: message,
      });
    } finally {
      closed = true;
      try {
        abortController.abort();
      } catch {
        // ignore
      }
      if (streamController) {
        streamController.close();
      } else {
        shouldCloseOnStart = true;
      }
    }
  })();

  const stream = new ReadableStream({
    start(controller) {
      streamController = controller;
      while (pendingChunks.length > 0) {
        controller.enqueue(pendingChunks.shift()!);
      }
      if (shouldCloseOnStart) {
        controller.close();
      }
    },
    cancel() {
      // Client disconnected: abort the handler so upstream operations can stop.
      try {
        abortController.abort("client_disconnect");
      } catch {
        // ignore
      }
    },
  });

  // Some test/runtime environments do not start stream processing until a reader
  // is acquired at least once. Prime the stream eagerly so handlers run as soon
  // as the Response is created, not only after the client starts reading.
  const primer = stream.getReader();
  primer.releaseLock();

  return stream;
}
