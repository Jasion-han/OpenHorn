import type { ApiAgentRun, ApiCitation, ApiLiveRoute, ApiLiveStatus } from "./api";
import { api, readErrorMessage } from "./api";
import { readSseStream, type SseEvent } from "./sse";

type ChatStreamEvent =
  | { type: "live_status"; status: ApiLiveStatus; route: ApiLiveRoute; label?: string }
  | { type: "citations"; citations: ApiCitation[] }
  | { type: "delta"; content: string }
  | { type: "done"; messageId?: string; model?: string; agentRun?: ApiAgentRun }
  | {
      type: "agent_event";
      event: { type: string; content?: string; toolName?: string; toolInput?: unknown };
    }
  | { type: "error"; message: string };

function isChatStreamEvent(event: SseEvent): event is ChatStreamEvent {
  return typeof event?.type === "string";
}

export async function streamChatMessage(
  input: {
    conversationId: string;
    content: string;
    attachments?: string[];
    mode?: "chat" | "agent";
  },
  handlers: {
    onLiveStatus?: (event: { status: ApiLiveStatus; route: ApiLiveRoute; label?: string }) => void;
    onCitations?: (event: { citations: ApiCitation[] }) => void;
    onDelta: (content: string) => void;
    onDone: (event: { messageId?: string; model?: string; agentRun?: ApiAgentRun }) => void;
    onAgentEvent?: (event: {
      type: string;
      content?: string;
      toolName?: string;
      toolInput?: unknown;
    }) => void;
    onError: (message: string) => void;
  },
  existingResponse?: Response,
) {
  const response = existingResponse ?? (await api.messages.stream(input));

  if (!response.ok) {
    throw new Error(await readErrorMessage(response, "Failed to stream message"));
  }

  await readSseStream(response, (rawEvent) => {
    if (!isChatStreamEvent(rawEvent)) {
      return;
    }

    if (rawEvent.type === "live_status") {
      handlers.onLiveStatus?.({
        status: rawEvent.status,
        route: rawEvent.route,
        label: rawEvent.label,
      });
      return;
    }

    if (rawEvent.type === "citations") {
      handlers.onCitations?.({
        citations: rawEvent.citations || [],
      });
      return;
    }

    if (rawEvent.type === "delta") {
      handlers.onDelta(rawEvent.content || "");
      return;
    }

    if (rawEvent.type === "done") {
      handlers.onDone({
        messageId: rawEvent.messageId,
        model: rawEvent.model,
        agentRun: rawEvent.agentRun,
      });
      return;
    }

    if (rawEvent.type === "agent_event") {
      handlers.onAgentEvent?.(rawEvent.event || { type: "meta" });
      return;
    }

    if (rawEvent.type === "error") {
      handlers.onError(rawEvent.message || "Stream error");
      return;
    }
  });
}
