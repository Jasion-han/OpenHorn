export type AgentEvent =
  | { type: "text"; content: string }
  | { type: "final_text"; content: string }
  | { type: "thinking"; content: string }
  | { type: "tool_start"; toolName?: string; toolInput?: unknown }
  | { type: "tool_result"; content?: string }
  | { type: "user_message"; userMessageId: string }
  | { type: "done" }
  | { type: "error"; content: string };

type SdkMessage = {
  type: string;
  [key: string]: unknown;
};

export function convertSdkEvent(message: SdkMessage): AgentEvent | AgentEvent[] | null {
  if (message.type === "user") {
    const uuid = typeof message.uuid === "string" ? message.uuid : null;
    if (uuid) return { type: "user_message", userMessageId: uuid };
  }

  if (message.type === "assistant" && message.message && typeof message.message === "object") {
    const msg = message.message as {
      content?: Array<{ type?: string; text?: string; name?: string; input?: unknown }>;
    };
    const events: AgentEvent[] = [];
    for (const block of msg.content || []) {
      if (block.type === "tool_use") {
        events.push({
          type: "tool_start",
          toolName: typeof block.name === "string" ? block.name : undefined,
          toolInput: block.input,
        });
      }
    }
    return events.length > 0 ? events : null;
  }

  if (message.type === "stream_event" && message.event && typeof message.event === "object") {
    const event = message.event as { type?: string; delta?: { text?: string } };
    if (event.type === "content_block_delta" && event.delta?.text) {
      return { type: "final_text", content: event.delta.text };
    }
  }

  if (message.type === "text" && typeof message.text === "string") {
    return null;
  }

  if (message.type === "tool_start") {
    return {
      type: "tool_start",
      toolName: typeof message.tool_name === "string" ? message.tool_name : undefined,
      toolInput: message.tool_input,
    };
  }

  if (message.type === "tool_result") {
    return {
      type: "tool_result",
      content: typeof message.content === "string" ? message.content : undefined,
    };
  }

  if (message.type === "tool_progress") {
    return {
      type: "tool_start",
      toolName: typeof message.tool_name === "string" ? message.tool_name : undefined,
    };
  }

  if (message.type === "tool_use_summary") {
    return {
      type: "tool_result",
      content: typeof message.summary === "string" ? message.summary : undefined,
    };
  }

  if (message.type === "result") {
    return null;
  }

  return null;
}
