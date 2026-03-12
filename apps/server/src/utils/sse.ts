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
  handler: (send: (event: SseEvent) => void, ctx: SseContext) => Promise<void>
): ReadableStream {
  let abortController: AbortController | null = null;
  return new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      abortController = new AbortController();
      const ctx: SseContext = { abortController, signal: abortController.signal };
      let closed = false;
      const send = (event: SseEvent) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(formatSseEvent(event)));
        } catch {
          // If the client disconnects, enqueue may throw. Treat it as closed.
          closed = true;
          try {
            abortController?.abort();
          } catch {
            // ignore
          }
        }
      };

      try {
        await handler(send, ctx);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Error';
        send({
          type: 'error',
          message,
          // Keep compatibility with consumers that expect "content" (Agent UI),
          // while still providing "message" (Chat UI).
          content: message,
        });
      } finally {
        closed = true;
        try {
          abortController?.abort();
        } catch {
          // ignore
        }
        controller.close();
      }
    },
    cancel() {
      // Client disconnected: abort the handler so upstream operations can stop.
      try {
        abortController?.abort();
      } catch {
        // ignore
      }
    },
  });
}
