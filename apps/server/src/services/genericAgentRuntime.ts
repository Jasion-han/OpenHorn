import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import type { AgentEvent } from "./agentService";
import { type ToolCallingAdapter } from "../agent-adapters";
import {
  type GenericAgentConversationMessage,
  type GenericToolCall,
  type GenericToolDefinition,
} from "./genericAgentTypes";
import { executeBashTool, formatBashToolResult } from "./bashToolExecutor";

const DEFAULT_MAX_TURNS = 6;

function getBashCommand(input: Record<string, unknown>) {
  if (typeof input.command === "string") return input.command;
  if (typeof input.cmd === "string") return input.cmd;
  return "";
}

export function buildGenericAgentTools(): GenericToolDefinition[] {
  return [
    {
      name: "bash",
      description:
        "Execute a shell command in the current project working directory. Use this when the task requires reading files, running commands, or inspecting the workspace.",
      inputSchema: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "The shell command to execute.",
          },
        },
        required: ["command"],
        additionalProperties: false,
      },
    },
  ];
}

async function executeToolCall(params: {
  toolCall: GenericToolCall;
  cwd: string;
  canUseTool?: CanUseTool;
  signal?: AbortSignal;
}): Promise<{ event: AgentEvent; nextMessage: GenericAgentConversationMessage } | null> {
  if (params.toolCall.name !== "bash") {
    const content = `Unsupported tool: ${params.toolCall.name}`;
    return {
      event: { type: "tool_result", toolName: params.toolCall.name, content },
      nextMessage: {
        role: "tool",
        toolCallId: params.toolCall.id,
        name: params.toolCall.name,
        content,
        isError: true,
      },
    };
  }

  if (params.canUseTool) {
    const decision = await params.canUseTool("Bash", params.toolCall.input, {
      toolUseID: params.toolCall.id,
      signal: params.signal,
    });
    if (decision.behavior === "deny") {
      throw new Error(
        typeof decision.message === "string" && decision.message.trim()
          ? decision.message
          : "Tool execution denied",
      );
    }
  }

  const result = await executeBashTool({
    command: getBashCommand(params.toolCall.input),
    cwd: params.cwd,
  });
  const content = formatBashToolResult(result);
  return {
    event: {
      type: "tool_result",
      toolName: "Bash",
      content,
    },
    nextMessage: {
      role: "tool",
      toolCallId: params.toolCall.id,
      name: "bash",
      content,
      isError: !result.success,
    },
  };
}

export async function* runGenericAgentRuntime(params: {
  adapter: ToolCallingAdapter;
  model: string;
  prompt: string;
  systemPrompt?: string;
  cwd: string;
  canUseTool?: CanUseTool;
  signal?: AbortSignal;
  maxTurns?: number;
}): AsyncGenerator<AgentEvent> {
  const messages: GenericAgentConversationMessage[] = [];
  if (params.systemPrompt?.trim()) {
    messages.push({ role: "system", content: params.systemPrompt.trim() });
  }
  messages.push({ role: "user", content: params.prompt.trim() || " " });

  const tools = buildGenericAgentTools();
  const maxTurns = params.maxTurns ?? DEFAULT_MAX_TURNS;

  for (let turn = 0; turn < maxTurns; turn += 1) {
    // Emit a keepalive before each model turn so slow but compatible
    // tool-calling providers are not misclassified as stalled immediately.
    yield { type: "meta" };

    const result = await params.adapter.runToolCallingTurn({
      model: params.model,
      messages,
      tools,
      signal: params.signal,
    });

    if (result.toolCalls.length > 0) {
      const interimText = result.text.trim();
      if (interimText) {
        yield { type: "thought", content: interimText };
      }

      messages.push({
        role: "assistant",
        content: result.text,
        toolCalls: result.toolCalls,
      });

      for (const toolCall of result.toolCalls) {
        yield {
          type: "tool_start",
          toolName: toolCall.name === "bash" ? "Bash" : toolCall.name,
          toolInput: toolCall.input,
        };
        const toolResult = await executeToolCall({
          toolCall,
          cwd: params.cwd,
          canUseTool: params.canUseTool,
          signal: params.signal,
        });
        if (!toolResult) continue;
        yield toolResult.event;
        messages.push(toolResult.nextMessage);
      }
      continue;
    }

    if (result.text.trim()) {
      yield { type: "text", content: result.text };
      return;
    }

    throw new Error(
      result.finishReason
        ? `执行失败：${result.finishReason}`
        : "执行失败：模型未返回最终结果",
    );
  }

  throw new Error("执行失败：超过最大工具调用轮数");
}
