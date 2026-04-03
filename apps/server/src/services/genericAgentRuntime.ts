import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import type { AgentEvent } from "./agentService";
import { supportsStreamingToolCalling, type ToolCallingAdapter } from "../agent-adapters";
import {
  type GenericAgentConversationMessage,
  type GenericToolCall,
  type GenericToolDefinition,
  type GenericAgentTurnResult,
} from "./genericAgentTypes";
import { executeBashTool, formatBashToolResult } from "./bashToolExecutor";

const DEFAULT_MAX_TURNS = 6;
const WORKSPACE_INSPECTION_PATTERN =
  /(^|[\s(])(?:readme|repo|repository|codebase|workspace|package\.json|tsconfig|src\/|apps\/|read README\.md)(?=$|[\s).,:/])/i;
const WORKSPACE_INSPECTION_ZH_PATTERN =
  /读取|查看|检查|分析|总结|梳理|修改|排查|修复|仓库|代码库|工作区|文件|源码|目录|README|package\.json/i;

function getBashCommand(input: Record<string, unknown>) {
  if (typeof input.command === "string") return input.command;
  if (typeof input.cmd === "string") return input.cmd;
  return "";
}

function shouldForceWorkspaceInspection(prompt: string) {
  return (
    WORKSPACE_INSPECTION_PATTERN.test(prompt) || WORKSPACE_INSPECTION_ZH_PATTERN.test(prompt)
  );
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
  const forceInitialWorkspaceInspection = shouldForceWorkspaceInspection(params.prompt);

  for (let turn = 0; turn < maxTurns; turn += 1) {
    // Emit a keepalive before each model turn so slow but compatible
    // tool-calling providers are not misclassified as stalled immediately.
    yield { type: "meta" };

    let result: GenericAgentTurnResult | null = null;
    let streamedText = false;
    let sawToolCallDelta = false;

    if (supportsStreamingToolCalling(params.adapter)) {
      for await (const event of params.adapter.runToolCallingTurnStream({
        model: params.model,
        messages,
        tools,
        toolChoice: turn === 0 && forceInitialWorkspaceInspection ? { type: "tool", name: "bash" } : "auto",
        signal: params.signal,
      })) {
        if (event.type === "text_delta") {
          streamedText = true;
          yield { type: "text_delta", content: event.content };
          continue;
        }

        if (event.type === "tool_call_delta") {
          sawToolCallDelta = true;
          if (streamedText) {
            yield { type: "text_reset" };
            streamedText = false;
          }
          continue;
        }

        result = event.result;
      }
    } else {
      result = await params.adapter.runToolCallingTurn({
        model: params.model,
        messages,
        tools,
        toolChoice: turn === 0 && forceInitialWorkspaceInspection ? { type: "tool", name: "bash" } : "auto",
        signal: params.signal,
      });
    }

    if (!result) {
      throw new Error("执行失败：模型未返回有效结果");
    }

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
      yield { type: "text", content: result.text, streamed: streamedText && !sawToolCallDelta };
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
