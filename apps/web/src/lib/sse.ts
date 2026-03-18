export type SseEvent = {
  type: string;
  [key: string]: unknown;
};

export function parseSseLines(buffer: string): {
  events: SseEvent[];
  rest: string;
} {
  const lines = buffer.split("\n");
  const rest = lines.pop() || "";
  const events: SseEvent[] = [];

  for (const line of lines) {
    if (!line.startsWith("data:")) continue;
    const payload = line.replace(/^data:\s?/, "");
    if (!payload.trim()) continue;
    try {
      events.push(JSON.parse(payload));
    } catch {
      // Skip malformed payloads
    }
  }

  return { events, rest };
}

export async function readSseStream(response: Response, onEvent: (event: SseEvent) => void) {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("No response body");
  }

  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const { events, rest } = parseSseLines(buffer);
    buffer = rest;

    for (const event of events) {
      onEvent(event);
    }
  }

  buffer += decoder.decode();
  if (buffer.trim()) {
    const { events } = parseSseLines(`${buffer}\n`);
    for (const event of events) {
      onEvent(event);
    }
  }
}
