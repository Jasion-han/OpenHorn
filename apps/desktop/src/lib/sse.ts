import type { ChatStreamEvent } from "../types/chat";

export type SseEvent = { type?: string; [key: string]: unknown };

export function parseSseLines<T extends SseEvent = ChatStreamEvent>(buffer: string): {
  events: T[];
  rest: string;
} {
  const lines = buffer.split("\n");
  const rest = lines.pop() || "";
  const events: T[] = [];

  for (const line of lines) {
    if (!line.startsWith("data:")) continue;
    const payload = line.replace(/^data:\s?/, "");
    if (!payload.trim()) continue;

    try {
      events.push(JSON.parse(payload) as T);
    } catch {
      continue;
    }
  }

  return { events, rest };
}

export async function readSseStream(
  response: Response,
  onEvent: (event: ChatStreamEvent) => void,
) {
  return readTypedSseStream(response, onEvent);
}

export async function readTypedSseStream<T extends SseEvent>(
  response: Response,
  onEvent: (event: T) => void,
) {
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
    const { events, rest } = parseSseLines<T>(buffer);
    buffer = rest;

    for (const event of events) {
      onEvent(event);
    }
  }

  buffer += decoder.decode();
  if (!buffer.trim()) return;

  const { events } = parseSseLines<T>(`${buffer}\n`);
  for (const event of events) {
    onEvent(event);
  }
}
