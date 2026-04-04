import type {
  CanUseTool,
  McpServerConfig,
  PermissionMode,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { AgentEvent } from "./agentService";

type SdkMessage = {
  type: string;
  [key: string]: unknown;
};

type SdkOptions = {
  apiKey: string;
  model: string;
  prompt: string | AsyncIterable<SDKUserMessage>;
  systemPrompt?: string;
  cwd?: string;
  mcpServers?: Record<string, McpServerConfig>;
  baseUrl?: string;
  abortController?: AbortController;
  permissionMode?: PermissionMode;
  canUseTool?: CanUseTool;
  allowDangerouslySkipPermissions?: boolean;
  maxTurns?: number;
  heartbeatMs?: number;
};

const DEFAULT_SDK_HEARTBEAT_MS = 5_000;

async function waitForSdkMessageOrHeartbeat<T>(
  nextPromise: Promise<IteratorResult<T>>,
  heartbeatMs: number,
): Promise<IteratorResult<T> | null> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      nextPromise,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), heartbeatMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

export async function* runClaudeAgentSdk(options: SdkOptions): AsyncGenerator<AgentEvent> {
  const sdk = await import("@anthropic-ai/claude-agent-sdk");

  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  // Claude Code SDK spawns a claude CLI subprocess; if the server itself runs inside
  // a Claude Code session the inherited CLAUDECODE env var causes the child to refuse
  // to start with "nested session" error. Always unset it for SDK invocations.
  delete env.CLAUDECODE;
  if (options.apiKey) {
    env.ANTHROPIC_API_KEY = options.apiKey;
  }
  if (options.baseUrl) {
    env.ANTHROPIC_BASE_URL = options.baseUrl;
  }

  const query = sdk.query({
    prompt: options.prompt,
    options: {
      abortController: options.abortController,
      model: options.model,
      cwd: options.cwd,
      env,
      tools: { type: "preset", preset: "claude_code" },
      permissionMode: options.permissionMode ?? "bypassPermissions",
      canUseTool: options.canUseTool,
      allowDangerouslySkipPermissions:
        options.permissionMode === "bypassPermissions" || !options.permissionMode
          ? (options.allowDangerouslySkipPermissions ?? true)
          : options.allowDangerouslySkipPermissions,
      maxTurns: options.maxTurns,
      ...(options.systemPrompt ? { systemPrompt: options.systemPrompt } : {}),
      ...(options.mcpServers && Object.keys(options.mcpServers).length > 0
        ? { mcpServers: options.mcpServers }
        : {}),
    },
  });

  const iterator = (query as AsyncIterable<SdkMessage>)[Symbol.asyncIterator]();
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_SDK_HEARTBEAT_MS;
  let sawSdkMessage = false;

  outer: while (true) {
    const nextPromise = iterator.next();

    while (true) {
      const next = sawSdkMessage
        ? await waitForSdkMessageOrHeartbeat(nextPromise, heartbeatMs)
        : await nextPromise;

      if (next === null) {
        yield { type: "meta" };
        continue;
      }

      if (next.done) {
        break outer;
      }

      sawSdkMessage = true;
      const converted = convertSdkEvent(next.value);
      if (converted) {
        yield converted;
      }
      break;
    }
  }

  yield { type: "done" };
}

export function convertSdkEvent(message: SdkMessage): AgentEvent | null {
  // System/SDK events: don't show in UI by default, but emit a meta event so
  // the server can treat "SDK is alive" as output and avoid false timeouts.
  if (message.type === "keep_alive") {
    return { type: "meta" };
  }

  if (message.type === "system" && typeof message.subtype === "string") {
    const subtype = message.subtype as string;
    if (subtype === "task_started") {
      const desc = typeof message.description === "string" ? message.description : "";
      return desc ? { type: "thought", content: desc } : { type: "meta" };
    }
    if (subtype === "task_notification") {
      const summary = typeof message.summary === "string" ? message.summary : "";
      return summary ? { type: "thought", content: summary } : { type: "meta" };
    }
    if (subtype === "local_command_output") {
      const content = typeof message.content === "string" ? message.content : "";
      return content ? { type: "thought", content } : { type: "meta" };
    }
    // init/status/task_progress/etc: keepalive only
    return { type: "meta" };
  }

  if (message.type === "result" && typeof message.subtype === "string") {
    const subtype = message.subtype as string;
    if (subtype === "success") {
      const result = typeof message.result === "string" ? message.result : "";
      return result.trim() ? { type: "text", content: result } : { type: "meta" };
    }
    const errors = Array.isArray(message.errors)
      ? message.errors.filter((e) => typeof e === "string")
      : [];
    const stop = typeof message.stop_reason === "string" ? message.stop_reason : null;
    if (errors.length === 0 && stop === "tool_use") {
      return { type: "meta" };
    }
    if (errors.length === 0 && (stop === "end_turn" || stop === "stop")) {
      const result = typeof message.result === "string" ? message.result : "";
      return result.trim() ? { type: "text", content: result } : { type: "meta" };
    }
    const content =
      errors.length > 0
        ? errors.map(normalizeSdkErrorText).join("\n")
        : stop
          ? `执行失败：${stop}`
          : "执行失败";
    return { type: "error", content };
  }

  if (message.type === "auth_status") {
    const error = typeof message.error === "string" ? message.error.trim() : "";
    if (error) {
      return { type: "error", content: normalizeSdkErrorText(error) };
    }
    return { type: "meta" };
  }

  if (message.type === "assistant" && message.message && typeof message.message === "object") {
    const content =
      (message.message as { content?: Array<{ type?: string; text?: string }> }).content || [];
    const text = content
      .filter((item) => item.type === "text" && typeof item.text === "string")
      .map((item) => item.text)
      .join("");
    if (text) {
      return { type: "text", content: text };
    }
    if (typeof message.error === "string" && message.error.trim()) {
      return { type: "error", content: mapAssistantError(message.error) };
    }
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

  if (message.type === "user") {
    return null;
  }

  return { type: "meta" };
}

export function mergeAgentTextOutput(current: string, incoming: string | null | undefined) {
  const next = incoming ?? "";
  if (!next) return current;
  if (!current) return next;

  const currentTrimmed = current.trim();
  const nextTrimmed = next.trim();

  if (!nextTrimmed) return current;
  if (!currentTrimmed) return next;
  if (current === next || currentTrimmed === nextTrimmed) return current;
  if (current.endsWith(next) || currentTrimmed.endsWith(nextTrimmed)) return current;

  // Some SDK/channel combinations stream partial assistant text and then emit the
  // full response again in result:success.result. Prefer the fuller version.
  if (nextTrimmed.startsWith(currentTrimmed)) {
    return next;
  }

  return `${current}${next}`;
}

function normalizeSdkErrorText(text: string) {
  const trimmed = text.trim();
  if (!trimmed) return "执行失败";
  if (/^network error$/i.test(trimmed)) {
    return "网络错误：当前渠道可能不兼容 Claude Agent SDK。请检查 Base URL、模型和鉴权配置。";
  }
  return trimmed;
}

function mapAssistantError(error: string) {
  switch (error) {
    case "authentication_failed":
      return "鉴权失败：请检查当前渠道的 API Key。";
    case "billing_error":
      return "计费状态异常：请检查当前渠道账号余额或计费设置。";
    case "rate_limit":
      return "请求限流：当前渠道触发了速率限制，请稍后重试。";
    case "invalid_request":
      return "请求无效：当前渠道或模型可能不兼容 Claude Agent SDK。";
    case "server_error":
      return "服务端错误：当前渠道返回了服务端异常。";
    case "max_output_tokens":
      return "输出被截断：模型达到了最大输出限制。";
    default:
      return "执行失败：当前渠道可能不兼容 Claude Agent SDK。";
  }
}
