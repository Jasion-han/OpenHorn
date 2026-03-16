import type { ApiAgentRun } from './api';
import { api } from './api';
import { readSseStream, type SseEvent } from './sse';

type ChatStreamEvent =
  | { type: 'delta'; content: string }
  | { type: 'done'; messageId?: string; model?: string; agentRun?: ApiAgentRun }
  | { type: 'agent_event'; event: { type: string; content?: string; toolName?: string; toolInput?: unknown } }
  | { type: 'error'; message: string };

function isChatStreamEvent(event: SseEvent): event is ChatStreamEvent {
  return typeof event?.type === 'string';
}

export async function streamChatMessage(
  input: {
    conversationId: string;
    content: string;
    attachments?: string[];
    mode?: 'chat' | 'agent';
  },
  handlers: {
    onDelta: (content: string) => void;
    onDone: (event: { messageId?: string; model?: string; agentRun?: ApiAgentRun }) => void;
    onAgentEvent?: (event: { type: string; content?: string; toolName?: string; toolInput?: unknown }) => void;
    onError: (message: string) => void;
  },
  existingResponse?: Response
) {
  const response = existingResponse ?? await api.messages.stream(input);

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(errorText || 'Failed to stream message');
  }

  await readSseStream(response, (rawEvent) => {
    if (!isChatStreamEvent(rawEvent)) {
      return;
    }

    if (rawEvent.type === 'delta') {
      handlers.onDelta(rawEvent.content || '');
      return;
    }

    if (rawEvent.type === 'done') {
      handlers.onDone({
        messageId: rawEvent.messageId,
        model: rawEvent.model,
      });
      return;
    }

    if (rawEvent.type === 'agent_event') {
      handlers.onAgentEvent?.(rawEvent.event || { type: 'meta' });
      return;
    }

    if (rawEvent.type === 'error') {
      handlers.onError(rawEvent.message || 'Stream error');
      return;
    }
  });
}
