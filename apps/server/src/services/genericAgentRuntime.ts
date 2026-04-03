import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import type { AgentEvent } from "./agentService";
import { supportsStreamingToolCalling, type ToolCallingAdapter } from "../agent-adapters";
import {
  type GenericAgentConversationMessage,
  type GenericToolCall,
  type GenericToolDefinition,
  type GenericAgentTurnResult,
} from "./genericAgentTypes";
import {
  executeBashTool,
  formatBashToolResult,
  summarizeBashToolResult,
} from "./bashToolExecutor";

const DEFAULT_MAX_TURNS = 10;
const WORKSPACE_INSPECTION_PATTERN =
  /(^|[\s(])(?:readme|repo|repository|codebase|workspace|package\.json|tsconfig|src\/|apps\/|read README\.md)(?=$|[\s).,:/])/i;
const WORKSPACE_INSPECTION_ZH_PATTERN =
  /读取|查看|检查|分析|总结|梳理|修改|排查|修复|仓库|代码库|工作区|文件|源码|目录|README|package\.json/i;
const GENERIC_AGENT_TOOL_GUARDRAILS = [
  "Use tools only when they materially help answer the task.",
  "For simple workspace inspection tasks, prefer 1 to 4 efficient Bash commands total.",
  "Use plain ASCII shell commands unless a path or file name genuinely requires non-ASCII.",
  "If a Bash command fails, simplify it and retry. Do not repeat malformed commands.",
  "When the needed evidence is already gathered, stop using tools and answer directly in the requested format.",
  "Do not ask the user to paste local files that you can read from the workspace yourself.",
].join("\n");

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

function collectBootstrapFiles(prompt: string) {
  const files: string[] = [];
  const push = (file: string) => {
    if (!files.includes(file)) files.push(file);
  };

  if (/\bREADME\.md\b/i.test(prompt) || /\bREADME\b/i.test(prompt)) push("README.md");
  if (/\bpackage\.json\b/i.test(prompt)) push("package.json");
  if (/\btsconfig\.json\b/i.test(prompt)) push("tsconfig.json");
  return files;
}

function buildBootstrapReadCommand(files: string[]) {
  if (files.length === 0) return null;
  return files
    .map(
      (file) =>
        `if [ -f ${JSON.stringify(file)} ]; then printf '===== FILE: ${file} =====\\n'; cat ${JSON.stringify(file)}; printf '\\n'; fi`,
    )
    .join("; ");
}

function isSuspiciousNonAsciiCommand(command: string) {
  if (!/[^\x00-\x7F]/.test(command)) {
    return false;
  }

  return /(^|[\s;|&(<])-[^\x00-\x7F]/.test(command) || /^[\x00-\x7F\s"'`$(){}\[\].,/:;|&<>=_*?!+-]+$/.test(command) === false;
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

  const command = getBashCommand(params.toolCall.input);
  if (isSuspiciousNonAsciiCommand(command)) {
    const content =
      "Malformed bash command rejected: use plain ASCII shell syntax and retry with a simpler command.";
    return {
      event: { type: "tool_result", toolName: "Bash", content: "invalid command" },
      nextMessage: {
        role: "tool",
        toolCallId: params.toolCall.id,
        name: "bash",
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
    command,
    cwd: params.cwd,
  });
  const content = formatBashToolResult(result);
  return {
    event: {
      type: "tool_result",
      toolName: "Bash",
      content: summarizeBashToolResult(result),
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
  const mergedSystemPrompt = [params.systemPrompt?.trim(), GENERIC_AGENT_TOOL_GUARDRAILS]
    .filter((value): value is string => Boolean(value))
    .join("\n\n");
  if (mergedSystemPrompt) {
    messages.push({ role: "system", content: mergedSystemPrompt });
  }
  messages.push({ role: "user", content: params.prompt.trim() || " " });

  const tools = buildGenericAgentTools();
  const maxTurns = params.maxTurns ?? DEFAULT_MAX_TURNS;
  const forceInitialWorkspaceInspection = shouldForceWorkspaceInspection(params.prompt);
  const bootstrapFiles = collectBootstrapFiles(params.prompt);
  const bootstrapCommand = buildBootstrapReadCommand(bootstrapFiles);

  if (bootstrapCommand) {
    const bootstrapToolCall: GenericToolCall = {
      id: crypto.randomUUID(),
      name: "bash",
      input: { command: bootstrapCommand },
    };
    yield {
      type: "tool_start",
      toolName: "Bash",
      toolInput: bootstrapToolCall.input,
    };
    const bootstrapResult = await executeToolCall({
      toolCall: bootstrapToolCall,
      cwd: params.cwd,
      canUseTool: params.canUseTool,
      signal: params.signal,
    });
    if (bootstrapResult) {
      yield bootstrapResult.event;
      messages.push({
        role: "assistant",
        content: "",
        toolCalls: [bootstrapToolCall],
      });
      messages.push(bootstrapResult.nextMessage);
    }
  }

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
        toolChoice:
          turn === 0 && forceInitialWorkspaceInspection && !bootstrapCommand
            ? { type: "tool", name: "bash" }
            : "auto",
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
        toolChoice:
          turn === 0 && forceInitialWorkspaceInspection && !bootstrapCommand
            ? { type: "tool", name: "bash" }
            : "auto",
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
