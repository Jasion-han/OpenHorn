import type { ChatStreamEvent } from "../types/chat";
import { getChatLabel } from "./i18n/agent";

export type SseEvent = { type?: string; [key: string]: unknown };

export function parseSseLines<T extends SseEvent = ChatStreamEvent>(
  buffer: string,
): {
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
      // A malformed frame is dropped rather than thrown: one bad payload in a
      // batch must not take the surviving events down with it.
    }
  }

  return { events, rest };
}

export async function readSseStream(response: Response, onEvent: (event: ChatStreamEvent) => void) {
  let receivedTerminal = false;
  await readTypedSseStream<ChatStreamEvent>(response, (event) => {
    if (event.type === "done" || event.type === "error") receivedTerminal = true;
    onEvent(event);
  });
  if (!receivedTerminal) throw new Error(getChatLabel("chat.error.streamInterrupted"));
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
  let completed = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const { events, rest } = parseSseLines<T>(buffer);
      buffer = rest;

      for (const event of events) onEvent(event);
    }
    buffer += decoder.decode();
    const { events } = parseSseLines<T>(`${buffer}\n`);
    for (const event of events) {
      onEvent(event);
    }
    completed = true;
  } finally {
    // A consumer callback can fail while the underlying request is still live.
    // Cancel without masking its error or waiting on an unresponsive source.
    if (!completed) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
