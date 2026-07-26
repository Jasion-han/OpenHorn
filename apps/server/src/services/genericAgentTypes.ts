export type {
  AgentCapabilityMode,
  GenericToolDefinition,
  GenericToolCall,
  GenericToolResult,
  GenericAgentConversationMessage,
  GenericAgentTurnResult,
} from "adapters/types";

/**
 * Event emitted by the Claude Agent SDK runner (`agentSdk.ts`).
 *
 * Previously declared in `agentService.ts` — the server-side agent runtime that
 * drove the removed `/agent/*` routes. That module is gone, but this type
 * outlived it because `channelAgentCheckService` still probes channels via
 * `runClaudeAgentSdk`.
 */
export interface AgentEvent {
  type:
    | "user"
    | "meta"
    | "thought"
    | "text_delta"
    | "text_reset"
    | "text"
    | "tool_start"
    | "tool_result"
    | "done"
    | "error";
  [key: string]: unknown;
  content?: string;
  toolName?: string;
  toolInput?: unknown;
}
