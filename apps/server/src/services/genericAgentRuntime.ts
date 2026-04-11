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

const DEFAULT_MAX_TURNS = 200;
const SYNTHETIC_TEXT_STREAM_CHUNK_SIZE = 18;
const SYNTHETIC_TEXT_STREAM_DELAY_MS = 14;
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

function extractPrimaryTaskPrompt(prompt: string) {
  const normalized = prompt.trim();
  if (!normalized) return "";

  const goalMarker = "Approved task goal:";
  const planMarker = "Approved execution plan:";
  const goalIndex = normalized.indexOf(goalMarker);
  const planIndex = normalized.indexOf(planMarker);

  if (goalIndex === -1 || planIndex === -1 || planIndex <= goalIndex) {
    return normalized;
  }

  const goal = normalized.slice(goalIndex + goalMarker.length, planIndex).trim();
  return goal || normalized;
}

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

function buildBootstrapWorkspaceCommand(prompt: string) {
  const normalized = prompt.trim();
  if (!normalized) return null;

  if (
    /\bpwd\b/i.test(normalized) ||
    /\bworkspace path\b/i.test(normalized) ||
    /\bcurrent working directory\b/i.test(normalized) ||
    /\bworking directory\b/i.test(normalized) ||
    /\bcurrent directory\b/i.test(normalized) ||
    /工作区路径|当前工作目录|当前目录|项目路径/.test(normalized)
  ) {
    return "pwd";
  }

  return null;
}

function isSuspiciousNonAsciiCommand(command: string) {
  if (!/[^\x00-\x7F]/.test(command)) {
    return false;
  }

  return /(^|[\s;|&(<])-[^\x00-\x7F]/.test(command) || /^[\x00-\x7F\s"'`$(){}\[\].,/:;|&<>=_*?!+-]+$/.test(command) === false;
}

async function* replayTextAsSyntheticStream(text: string): AsyncGenerator<AgentEvent> {
  const segments = Array.from(text);
  for (let index = 0; index < segments.length; index += SYNTHETIC_TEXT_STREAM_CHUNK_SIZE) {
    const content = segments
      .slice(index, index + SYNTHETIC_TEXT_STREAM_CHUNK_SIZE)
      .join("");
    if (!content) continue;
    yield { type: "text_delta", content };
    if (index + SYNTHETIC_TEXT_STREAM_CHUNK_SIZE < segments.length) {
      await new Promise((resolve) => setTimeout(resolve, SYNTHETIC_TEXT_STREAM_DELAY_MS));
    }
  }
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
  const taskPrompt = extractPrimaryTaskPrompt(params.prompt);
  const forceInitialWorkspaceInspection = shouldForceWorkspaceInspection(taskPrompt);
  const bootstrapFiles = collectBootstrapFiles(taskPrompt);
  const bootstrapCommand =
    buildBootstrapReadCommand(bootstrapFiles) || buildBootstrapWorkspaceCommand(taskPrompt);

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
        toolChoice: "auto",
        signal: params.signal,
      })) {
        if (event.type === "text_delta") {
          streamedText = true;
          yield { type: "text_delta", content: event.content };
          continue;
        }

        if (event.type === "tool_call_delta") {
          sawToolCallDelta = true;
          // Don't emit text_reset — let the streamed text stay visible
          // until the tool_start event replaces it. This avoids the flash
          // where text appears then immediately vanishes.
          continue;
        }

        result = event.result;
      }
    } else {
      result = await params.adapter.runToolCallingTurn({
        model: params.model,
        messages,
        tools,
        toolChoice: "auto",
        signal: params.signal,
      });
    }

    if (!result) {
      throw new Error("Execution failed: model returned no valid result");
    }

    if (result.toolCalls.length > 0) {
      const interimText = result.text.trim();
      // Only emit thought if the text was NOT already streamed via
      // text_delta events — avoids duplicating content the user already saw.
      if (interimText && !streamedText) {
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
      if (!streamedText) {
        for await (const syntheticEvent of replayTextAsSyntheticStream(result.text)) {
          yield syntheticEvent;
        }
        streamedText = true;
      }
      yield {
        type: "text",
        content: result.text,
        streamed: streamedText && !sawToolCallDelta,
        final: true,
      };
      return;
    }

    throw new Error(
      result.finishReason
        ? `Execution failed: model returned no valid result (finish_reason: ${result.finishReason})`
        : "Execution failed: model returned no final result",
    );
  }

  throw new Error("Execution failed: exceeded the maximum tool-call rounds");
}
