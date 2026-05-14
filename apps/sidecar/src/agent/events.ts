export type AgentEvent =
  | { type: "text"; content: string }
  | { type: "final_text"; content: string }
  | { type: "tool_start"; toolName?: string; toolInput?: unknown }
  | { type: "tool_result"; content?: string }
  | { type: "user_message"; userMessageId: string }
  | { type: "done" }
  | { type: "error"; content: string };

type SdkMessage = {
  type: string;
  [key: string]: unknown;
};

export function convertSdkEvent(message: SdkMessage): AgentEvent | null {
  if (message.type === "user") {
    const uuid = typeof message.uuid === "string" ? message.uuid : null;
    if (uuid) return { type: "user_message", userMessageId: uuid };
  }

  if (message.type === "assistant" && message.message && typeof message.message === "object") {
    const content =
      (message.message as { content?: Array<{ type?: string; text?: string }> }).content || [];
    const text = content
      .filter((item) => item.type === "text" && typeof item.text === "string")
      .map((item) => item.text)
      .join("");
    if (text) return { type: "text", content: text };
  }

  if (message.type === "stream_event" && message.event && typeof message.event === "object") {
    const event = message.event as { type?: string; delta?: { text?: string } };
    if (event.type === "content_block_delta" && event.delta?.text) {
      return { type: "text", content: event.delta.text };
    }
  }

  if (message.type === "text" && typeof message.text === "string") {
    return { type: "text", content: message.text };
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
    const result = typeof message.result === "string" ? message.result : "";
    if (result) return { type: "final_text", content: result };
  }

  return null;
}
