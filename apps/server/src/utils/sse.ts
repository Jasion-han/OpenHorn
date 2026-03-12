export type SseEvent = {
  type: string;
  [key: string]: unknown;
};

export function formatSseEvent(event: SseEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

export function createSseStream(
  handler: (send: (event: SseEvent) => void) => Promise<void>
): ReadableStream {
  return new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      const send = (event: SseEvent) => {
        controller.enqueue(encoder.encode(formatSseEvent(event)));
      };

      try {
        await handler(send);
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
        controller.close();
      }
    },
  });
}
