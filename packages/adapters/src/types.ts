export type AgentCapabilityMode = "claude_sdk" | "generic_tool_calling";

export type GenericToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export type GenericToolCall = {
  id: string;
  name: string;
  input: Record<string, unknown>;
};

export type GenericToolResult = {
  toolCallId: string;
  name: string;
  content: string;
  isError?: boolean;
};

export type GenericAgentConversationMessage =
  | {
      role: "system" | "user";
      content: string;
    }
  | {
      role: "assistant";
      content: string;
      toolCalls?: GenericToolCall[];
    }
  | {
      role: "tool";
      toolCallId: string;
      name: string;
      content: string;
      isError?: boolean;
    };

export type GenericAgentTurnResult = {
  text: string;
  toolCalls: GenericToolCall[];
  finishReason?: string | null;
};
