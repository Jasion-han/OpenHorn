export type ChatContentPart =
  | { type: "text"; text: string }
  | { type: "image"; mediaType: string; dataBase64: string; fileName?: string };

export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string | ChatContentPart[];
}

export interface ChatOptions {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  requestTimeoutMs?: number;
  streamFirstTokenTimeoutMs?: number;
  streamIdleTimeoutMs?: number;
  streamTotalTimeoutMs?: number;
}

export interface ChatResponse {
  id: string;
  model: string;
  content: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

export interface ProviderAdapter {
  chat(options: ChatOptions): Promise<ChatResponse>;
  chatStream(options: ChatOptions): AsyncGenerator<string>;
}

import type {
  GenericAgentConversationMessage,
  GenericAgentTurnResult,
  GenericToolDefinition,
} from "./services/genericAgentTypes";

export interface ToolCallingOptions {
  model: string;
  messages: GenericAgentConversationMessage[];
  tools: GenericToolDefinition[];
  toolChoice?: "auto" | { type: "tool"; name: string };
  signal?: AbortSignal;
  requestTimeoutMs?: number;
}

export type ToolCallingStreamEvent =
  | { type: "text_delta"; content: string }
  | { type: "tool_call_delta" }
  | { type: "done"; result: GenericAgentTurnResult };

export interface ToolCallingAdapter extends ProviderAdapter {
  runToolCallingTurn(options: ToolCallingOptions): Promise<GenericAgentTurnResult>;
}

export interface StreamingToolCallingAdapter extends ToolCallingAdapter {
  runToolCallingTurnStream(options: ToolCallingOptions): AsyncGenerator<ToolCallingStreamEvent>;
}

export type AdapterProtocol = "openai" | "anthropic" | "google";

type NonSystemChatMessage = Omit<ChatMessage, "role"> & { role: "user" | "assistant" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function toFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

const DEFAULT_REQUEST_TIMEOUT_MS = 45_000;
// Real-world providers, compatible gateways, and multimodal requests can all
// take noticeably longer before the first streamed chunk arrives.
const DEFAULT_STREAM_FIRST_TOKEN_TIMEOUT_MS = 30_000;
const DEFAULT_TOOL_CALLING_STREAM_FIRST_TOKEN_TIMEOUT_MS = 90_000;
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 60_000;
const DEFAULT_STREAM_TOTAL_TIMEOUT_MS = 180_000;

export function resolveToolCallingStreamFirstTokenTimeoutMs(requestTimeoutMs?: number) {
  const requestTimeout = toFiniteNumber(requestTimeoutMs);
  if (requestTimeout !== null && requestTimeout > 0) {
    return Math.min(requestTimeout, DEFAULT_TOOL_CALLING_STREAM_FIRST_TOKEN_TIMEOUT_MS);
  }
  return DEFAULT_TOOL_CALLING_STREAM_FIRST_TOKEN_TIMEOUT_MS;
}

function shouldRetryStatus(status: number) {
  return status === 429 || status === 502 || status === 503 || status === 504;
}

function createTimeoutError(message: string) {
  const error = new Error(message);
  error.name = "TimeoutError";
  return error;
}

function linkAbortSignal(signal?: AbortSignal) {
  const controller = new AbortController();
  if (!signal) {
    return { controller, cleanup: () => undefined };
  }
  if (signal.aborted) {
    controller.abort(signal.reason);
    return { controller, cleanup: () => undefined };
  }

  const onAbort = () => controller.abort(signal.reason);
  signal.addEventListener("abort", onAbort, { once: true });
  return {
    controller,
    cleanup: () => signal.removeEventListener("abort", onAbort),
  };
}

function createRequestTimeoutSignal(signal: AbortSignal | undefined, timeoutMs: number) {
  const { controller, cleanup: cleanupLinkedSignal } = linkAbortSignal(signal);
  const timer = setTimeout(() => {
    if (!controller.signal.aborted) {
      controller.abort(
        createTimeoutError(`模型响应超时（${Math.round(timeoutMs / 1000)}s）已停止。`),
      );
    }
  }, timeoutMs);

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      cleanupLinkedSignal();
    },
  };
}

function createStreamTimeoutSignal(options?: {
  signal?: AbortSignal;
  firstTokenTimeoutMs?: number;
  idleTimeoutMs?: number;
  totalTimeoutMs?: number;
}) {
  const firstTokenTimeoutMs =
    options?.firstTokenTimeoutMs ?? DEFAULT_STREAM_FIRST_TOKEN_TIMEOUT_MS;
  const idleTimeoutMs = options?.idleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS;
  const totalTimeoutMs = options?.totalTimeoutMs ?? DEFAULT_STREAM_TOTAL_TIMEOUT_MS;
  const { controller, cleanup: cleanupLinkedSignal } = linkAbortSignal(options?.signal);

  let sawFirstChunk = false;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const firstTokenTimer = setTimeout(() => {
    if (!controller.signal.aborted) {
      controller.abort(
        createTimeoutError(`模型首个响应超时（${Math.round(firstTokenTimeoutMs / 1000)}s）已停止。`),
      );
    }
  }, firstTokenTimeoutMs);
  const totalTimer = setTimeout(() => {
    if (!controller.signal.aborted) {
      controller.abort(
        createTimeoutError(`模型响应总时长超时（${Math.round(totalTimeoutMs / 1000)}s）已停止。`),
      );
    }
  }, totalTimeoutMs);

  return {
    signal: controller.signal,
    markChunk: () => {
      if (!sawFirstChunk) {
        sawFirstChunk = true;
        clearTimeout(firstTokenTimer);
      }
      if (idleTimer) {
        clearTimeout(idleTimer);
      }
      idleTimer = setTimeout(() => {
        if (!controller.signal.aborted) {
          controller.abort(
            createTimeoutError(`模型流式输出空闲超时（${Math.round(idleTimeoutMs / 1000)}s）已停止。`),
          );
        }
      }, idleTimeoutMs);
    },
    cleanup: () => {
      clearTimeout(firstTokenTimer);
      clearTimeout(totalTimer);
      if (idleTimer) {
        clearTimeout(idleTimer);
      }
      cleanupLinkedSignal();
    },
  };
}

function rethrowAbortReason(signal: AbortSignal, error: unknown): never {
  if (signal.aborted && signal.reason instanceof Error) {
    throw signal.reason;
  }
  throw (error instanceof Error ? error : new Error(String(error)));
}

async function readErrorDetail(response: Response): Promise<string> {
  const contentType = response.headers.get("content-type") || "";
  const extractJsonErrorMessage = (data: unknown) => {
    if (!isRecord(data)) return null;
    const err = data.error;
    if (isRecord(err) && typeof err.message === "string") return err.message;
    if (typeof data.message === "string") return data.message;
    if (typeof data.error === "string") return data.error;
    if (typeof data.detail === "string") return data.detail;
    return null;
  };
  try {
    if (contentType.includes("application/json")) {
      const data = (await response.json().catch(() => null)) as unknown;
      const msg = extractJsonErrorMessage(data);
      if (typeof msg === "string" && msg.trim()) return msg.trim().slice(0, 800);
      return JSON.stringify(data).slice(0, 800);
    }
  } catch {
    // ignore
  }
  const text = await response.text().catch(() => "");
  const normalizedText = text.trim();
  if (normalizedText.startsWith("{") || normalizedText.startsWith("[")) {
    try {
      const parsed = JSON.parse(normalizedText) as unknown;
      const msg = extractJsonErrorMessage(parsed);
      if (typeof msg === "string" && msg.trim()) return msg.trim().slice(0, 800);
      return JSON.stringify(parsed).slice(0, 800);
    } catch {
      // ignore invalid JSON-like text
    }
  }
  return (text || response.statusText || "Request failed").toString().slice(0, 800);
}

function formatProviderApiError(status: number | undefined, detail: string) {
  const suffix = status ? ` (${status})` : "";
  return `Provider API error${suffix}: ${detail}`;
}

function shouldRetryWithoutForcedToolChoice(detail: string) {
  const normalized = detail.toLowerCase();
  return (
    normalized.includes("tool_choice") &&
    (normalized.includes("does not support being set to required") ||
      normalized.includes("does not support being set to required or object") ||
      normalized.includes("thinking mode"))
  );
}

function asTextContent(content: ChatMessage["content"]): string {
  if (typeof content === "string") return content;
  return content
    .filter((p) => p.type === "text")
    .map((p) => p.text)
    .join("");
}

function isNonSystemMessage(message: ChatMessage): message is NonSystemChatMessage {
  return message.role !== "system";
}

function splitSystem(messages: ChatMessage[]) {
  const systemParts: string[] = [];
  const rest: NonSystemChatMessage[] = [];

  for (const m of messages) {
    if (m.role === "system") {
      const text = asTextContent(m.content).trim();
      if (text) systemParts.push(text);
      continue;
    }
    if (isNonSystemMessage(m)) {
      rest.push(m);
    }
  }

  return {
    system: systemParts.length > 0 ? systemParts.join("\n\n") : undefined,
    messages: rest,
  };
}

function extractOpenAITextContent(rawContent: unknown): string {
  if (typeof rawContent === "string") {
    return rawContent;
  }

  if (!Array.isArray(rawContent)) {
    return "";
  }

  return rawContent
    .filter(
      (item): item is { type?: string; text?: string } =>
        isRecord(item) && typeof item.text === "string",
    )
    .map((item) => item.text ?? "")
    .join("");
}

function normalizeToolNameKey(name: string) {
  let key = (name || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
  key = key.replace(/^tool/, "");
  key = key.replace(/tool$/, "");
  return key;
}

function canonicalizeToolName(name: string, tools?: GenericToolDefinition[]) {
  const trimmed = name.trim();
  if (!trimmed || !tools || tools.length === 0) {
    return trimmed;
  }

  const directMatch = tools.find((tool) => tool.name === trimmed);
  if (directMatch) {
    return directMatch.name;
  }

  const normalized = normalizeToolNameKey(trimmed);
  if (!normalized) {
    return trimmed;
  }

  const looseMatch = tools.find((tool) => normalizeToolNameKey(tool.name) === normalized);
  return looseMatch?.name ?? trimmed;
}

function parseOpenAIToolCalls(
  rawToolCalls: unknown,
  tools?: GenericToolDefinition[],
): GenericAgentTurnResult["toolCalls"] {
  if (!Array.isArray(rawToolCalls)) {
    return [];
  }

  return rawToolCalls
    .map((toolCall) => {
      if (!isRecord(toolCall) || !isRecord(toolCall.function)) {
        return null;
      }
      const id = typeof toolCall.id === "string" ? toolCall.id : crypto.randomUUID();
      const name =
        typeof toolCall.function.name === "string"
          ? canonicalizeToolName(toolCall.function.name, tools)
          : "";
      if (!name) return null;
      const argsRaw =
        typeof toolCall.function.arguments === "string" ? toolCall.function.arguments : "{}";
      let input: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(argsRaw) as unknown;
        if (isRecord(parsed)) {
          input = parsed;
        }
      } catch {
        input = {};
      }
      return { id, name, input };
    })
    .filter((toolCall): toolCall is GenericAgentTurnResult["toolCalls"][number] =>
      Boolean(toolCall),
    );
}

function parseOpenAIToolCallingResult(
  data: unknown,
  tools?: GenericToolDefinition[],
): GenericAgentTurnResult {
  if (!isRecord(data)) {
    throw new Error("OpenAI API error: Invalid JSON response");
  }

  const choices = Array.isArray(data.choices) ? data.choices : [];
  const first = choices[0];
  const message = isRecord(first) ? first.message : null;
  if (!isRecord(message)) {
    throw new Error("OpenAI API error: Missing response message");
  }

  return {
    text: extractOpenAITextContent(message.content),
    toolCalls: parseOpenAIToolCalls(message.tool_calls, tools),
    finishReason:
      isRecord(first) && typeof first.finish_reason === "string" ? first.finish_reason : null,
  };
}

function normalizeBaseUrl(url: string): string {
  let u = url.replace(/\/+$/, "");
  if (u.endsWith("/v1")) u = u.slice(0, -3);
  return u;
}

export class OpenAIAdapter implements ProviderAdapter {
  private apiKey: string;
  private baseUrl: string;

  constructor(apiKey: string, baseUrl?: string) {
    this.apiKey = apiKey;
    const raw = baseUrl || "https://api.openai.com/v1";
    this.baseUrl = normalizeBaseUrl(raw) + "/v1";
  }

  async chat(options: ChatOptions): Promise<ChatResponse> {
    const url = `${this.baseUrl}/chat/completions`;
    const body = JSON.stringify({
      model: options.model,
      messages: options.messages.map((m) => {
        if (typeof m.content === "string") return m;
        return {
          role: m.role,
          content: m.content.map((p) => {
            if (p.type === "text") {
              return { type: "text", text: p.text };
            }
            return {
              type: "image_url",
              image_url: { url: `data:${p.mediaType};base64,${p.dataBase64}` },
            };
          }),
        };
      }),
      temperature: options.temperature,
      max_tokens: options.maxTokens,
    });

    const timeout = createRequestTimeoutSignal(
      options.signal,
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    );
    let response: Response | null = null;
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        response = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.apiKey}`,
          },
          body,
          signal: timeout.signal,
        });
        if (response.ok) break;
        if (!shouldRetryStatus(response.status) || attempt === 1) break;
        await sleep(500 * (attempt + 1));
      }
    } catch (error) {
      timeout.cleanup();
      rethrowAbortReason(timeout.signal, error);
    }
    timeout.cleanup();

    if (timeout.signal.aborted && timeout.signal.reason instanceof Error) {
      throw timeout.signal.reason;
    }

    if (!response || !response.ok) {
      const detail = response ? await readErrorDetail(response) : "Request failed";
      const status = response?.status ? ` (${response.status})` : "";
      throw new Error(`OpenAI API error${status}: ${detail}`);
    }

    const data = (await response.json()) as unknown;
    if (!isRecord(data)) {
      throw new Error("OpenAI API error: Invalid JSON response");
    }
    const id = typeof data.id === "string" ? data.id : "";
    const model = typeof data.model === "string" ? data.model : options.model;
    const choices = Array.isArray(data.choices) ? data.choices : [];
    const first = choices[0];
    const message = isRecord(first) ? first.message : null;
    const content =
      isRecord(message) && typeof message.content === "string" ? message.content : null;
    if (!content) {
      throw new Error("OpenAI API error: Missing response content");
    }
    const usageRaw = isRecord(data.usage) ? data.usage : null;
    const promptTokens = usageRaw ? toFiniteNumber(usageRaw.prompt_tokens) : null;
    const completionTokens = usageRaw ? toFiniteNumber(usageRaw.completion_tokens) : null;
    const totalTokens = usageRaw ? toFiniteNumber(usageRaw.total_tokens) : null;
    return {
      id,
      model,
      content,
      usage:
        promptTokens !== null && completionTokens !== null && totalTokens !== null
          ? { promptTokens, completionTokens, totalTokens }
          : undefined,
    };
  }

  async *chatStream(options: ChatOptions): AsyncGenerator<string> {
    const url = `${this.baseUrl}/chat/completions`;
    const body = JSON.stringify({
      model: options.model,
      messages: options.messages.map((m) => {
        if (typeof m.content === "string") return m;
        return {
          role: m.role,
          content: m.content.map((p) => {
            if (p.type === "text") {
              return { type: "text", text: p.text };
            }
            return {
              type: "image_url",
              image_url: { url: `data:${p.mediaType};base64,${p.dataBase64}` },
            };
          }),
        };
      }),
      temperature: options.temperature,
      max_tokens: options.maxTokens,
      stream: true,
    });

    const timeout = createStreamTimeoutSignal({
      signal: options.signal,
      firstTokenTimeoutMs: options.streamFirstTokenTimeoutMs,
      idleTimeoutMs: options.streamIdleTimeoutMs,
      totalTimeoutMs: options.streamTotalTimeoutMs,
    });
    let response: Response | null = null;
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        response = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "text/event-stream",
            Authorization: `Bearer ${this.apiKey}`,
          },
          body,
          signal: timeout.signal,
        });
        if (response.ok) break;
        if (!shouldRetryStatus(response.status) || attempt === 1) break;
        await sleep(500 * (attempt + 1));
      }
    } catch (error) {
      timeout.cleanup();
      rethrowAbortReason(timeout.signal, error);
    }

    if (timeout.signal.aborted && timeout.signal.reason instanceof Error) {
      timeout.cleanup();
      throw timeout.signal.reason;
    }

    if (!response || !response.ok) {
      timeout.cleanup();
      const detail = response ? await readErrorDetail(response) : "Request failed";
      const status = response?.status ? ` (${response.status})` : "";
      throw new Error(`OpenAI API error${status}: ${detail}`);
    }

    const reader = response.body?.getReader();
    if (!reader) {
      timeout.cleanup();
      throw new Error("No response body");
    }

    const decoder = new TextDecoder();
    let buffer = "";

    const looksLikeSsePayload = (text: string) => {
      for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line) continue;
        return (
          line.startsWith(":") ||
          line.startsWith("data:") ||
          line.startsWith("event:") ||
          line.startsWith("id:") ||
          line.startsWith("retry:")
        );
      }
      return false;
    };

    const consumeSseBuffer = (flush = false) => {
      const working = flush && buffer.length > 0 ? `${buffer}\n` : buffer;
      const lines = working.split("\n");
      buffer = flush ? "" : lines.pop() || "";

      const payloads: string[] = [];
      let done = false;

      for (const rawLine of lines) {
        const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(":")) continue;
        if (!trimmed.startsWith("data:")) continue;

        const data = trimmed.slice(5).trimStart();
        if (data === "[DONE]") {
          done = true;
          break;
        }
        payloads.push(data);
      }

      return { payloads, done };
    };

    // Some proxies incorrectly label streaming responses as application/json.
    // Sniff the first chunk: if it looks like SSE ("data:" lines), parse as stream.
    try {
      const firstRead = await reader.read();
      if (firstRead.done) return;

      timeout.markChunk();
      const firstChunkText = decoder.decode(firstRead.value, { stream: true });
      buffer += firstChunkText;

      const looksLikeSse = looksLikeSsePayload(buffer);

      if (!looksLikeSse) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          timeout.markChunk();
          buffer += decoder.decode(value, { stream: true });
        }
        const raw = buffer.trim();
        if (!raw) return;
        try {
          const data = JSON.parse(raw);
          const content =
            data?.choices?.[0]?.message?.content ?? data?.choices?.[0]?.delta?.content ?? "";
          if (typeof content === "string" && content.length > 0) {
            yield content;
          }
        } catch {
          yield raw;
        }
        return;
      }

      while (true) {
        const { payloads, done: sseDone } = consumeSseBuffer();
        for (const data of payloads) {
          try {
            const parsed = JSON.parse(data);
            const content = parsed.choices[0]?.delta?.content;
            if (content) yield content;
          } catch {
            // Skip invalid JSON
          }
        }
        if (sseDone) return;

        const { done: streamDone, value } = await reader.read();
        if (streamDone) {
          const remaining = consumeSseBuffer(true);
          for (const data of remaining.payloads) {
            try {
              const parsed = JSON.parse(data);
              const content = parsed.choices[0]?.delta?.content;
              if (content) yield content;
            } catch {
              // Skip invalid JSON
            }
          }
          if (remaining.done) return;
          break;
        }
        timeout.markChunk();
        buffer += decoder.decode(value, { stream: true });
      }
    } catch (error) {
      rethrowAbortReason(timeout.signal, error);
    } finally {
      timeout.cleanup();
    }
  }

  async runToolCallingTurn(options: ToolCallingOptions): Promise<GenericAgentTurnResult> {
    const url = `${this.baseUrl}/chat/completions`;
    const body = JSON.stringify({
      model: options.model,
      messages: options.messages.map((message) => {
        if (message.role === "system" || message.role === "user") {
          return {
            role: message.role,
            content: message.content,
          };
        }
        if (message.role === "assistant") {
          return {
            role: "assistant",
            content: message.content || "",
            ...(message.toolCalls && message.toolCalls.length > 0
              ? {
                  tool_calls: message.toolCalls.map((toolCall) => ({
                    id: toolCall.id,
                    type: "function",
                    function: {
                      name: toolCall.name,
                      arguments: JSON.stringify(toolCall.input),
                    },
                  })),
                }
              : {}),
          };
        }
        if (message.role !== "tool") {
          return {
            role: "user",
            content: message.content,
          };
        }
        return {
          role: "tool",
          tool_call_id: message.toolCallId,
          content: message.content,
        };
      }),
      tools: options.tools.map((tool) => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
        },
      })),
      tool_choice:
        options.toolChoice && options.toolChoice !== "auto"
          ? {
              type: "function",
              function: { name: options.toolChoice.name },
            }
          : "auto",
    });

    const timeout = createRequestTimeoutSignal(
      options.signal,
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    );
    let response: Response | null = null;
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        response = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.apiKey}`,
          },
          body,
          signal: timeout.signal,
        });
        if (response.ok) break;
        if (!shouldRetryStatus(response.status) || attempt === 1) break;
        await sleep(500 * (attempt + 1));
      }
    } catch (error) {
      timeout.cleanup();
      rethrowAbortReason(timeout.signal, error);
    }
    timeout.cleanup();

    if (timeout.signal.aborted && timeout.signal.reason instanceof Error) {
      throw timeout.signal.reason;
    }

    if (!response || !response.ok) {
      const detail = response ? await readErrorDetail(response) : "Request failed";
      const status = response?.status ? ` (${response.status})` : "";
      throw new Error(`OpenAI API error${status}: ${detail}`);
    }

    const data = (await response.json()) as unknown;
    return parseOpenAIToolCallingResult(data, options.tools);
  }

  async *runToolCallingTurnStream(
    options: ToolCallingOptions,
  ): AsyncGenerator<ToolCallingStreamEvent> {
    const url = `${this.baseUrl}/chat/completions`;
    const body = JSON.stringify({
      model: options.model,
      messages: options.messages.map((message) => {
        if (message.role === "system" || message.role === "user") {
          return {
            role: message.role,
            content: message.content,
          };
        }
        if (message.role === "assistant") {
          return {
            role: "assistant",
            content: message.content || "",
            ...(message.toolCalls && message.toolCalls.length > 0
              ? {
                  tool_calls: message.toolCalls.map((toolCall) => ({
                    id: toolCall.id,
                    type: "function",
                    function: {
                      name: toolCall.name,
                      arguments: JSON.stringify(toolCall.input),
                    },
                  })),
                }
              : {}),
          };
        }
        if (message.role !== "tool") {
          return {
            role: "user",
            content: message.content,
          };
        }
        return {
          role: "tool",
          tool_call_id: message.toolCallId,
          content: message.content,
        };
      }),
      tools: options.tools.map((tool) => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
        },
      })),
      tool_choice:
        options.toolChoice && options.toolChoice !== "auto"
          ? {
              type: "function",
              function: { name: options.toolChoice.name },
            }
          : "auto",
      stream: true,
    });

    const timeout = createStreamTimeoutSignal({
      signal: options.signal,
      totalTimeoutMs: options.requestTimeoutMs ?? DEFAULT_STREAM_TOTAL_TIMEOUT_MS,
      firstTokenTimeoutMs: resolveToolCallingStreamFirstTokenTimeoutMs(options.requestTimeoutMs),
    });
    let response: Response | null = null;
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        response = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "text/event-stream",
            Authorization: `Bearer ${this.apiKey}`,
          },
          body,
          signal: timeout.signal,
        });
        if (response.ok) break;
        if (!shouldRetryStatus(response.status) || attempt === 1) break;
        await sleep(500 * (attempt + 1));
      }
    } catch (error) {
      timeout.cleanup();
      rethrowAbortReason(timeout.signal, error);
    }

    if (timeout.signal.aborted && timeout.signal.reason instanceof Error) {
      timeout.cleanup();
      throw timeout.signal.reason;
    }

    if (!response || !response.ok) {
      timeout.cleanup();
      const detail = response ? await readErrorDetail(response) : "Request failed";
      const status = response?.status ? ` (${response.status})` : "";
      throw new Error(`OpenAI API error${status}: ${detail}`);
    }

    const reader = response.body?.getReader();
    if (!reader) {
      timeout.cleanup();
      throw new Error("No response body");
    }

    const decoder = new TextDecoder();
    let buffer = "";
    let sawToolCallDelta = false;
    let text = "";
    let finishReason: string | null = null;
    const toolCallsByIndex = new Map<
      number,
      { id?: string; name: string; argumentsText: string }
    >();

    const emitParsedPayload = function* (payload: string): Generator<ToolCallingStreamEvent> {
      const parsed = JSON.parse(payload) as unknown;
      if (!isRecord(parsed)) return;
      const choice = Array.isArray(parsed.choices) ? parsed.choices[0] : null;
      if (!isRecord(choice)) return;

      if (typeof choice.finish_reason === "string" && choice.finish_reason.trim()) {
        finishReason = choice.finish_reason;
      }

      const delta = isRecord(choice.delta) ? choice.delta : null;
      if (!delta) return;

      const content = delta.content;
      if (typeof content === "string" && content.length > 0) {
        text += content;
        yield { type: "text_delta", content };
      }

      const toolCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
      for (const toolCall of toolCalls) {
        if (!isRecord(toolCall)) continue;
        const index = typeof toolCall.index === "number" ? toolCall.index : 0;
        const current = toolCallsByIndex.get(index) || {
          id: undefined,
          name: "",
          argumentsText: "",
        };
        if (typeof toolCall.id === "string" && toolCall.id.trim()) {
          current.id = toolCall.id;
        }
        const toolFunction = isRecord(toolCall.function) ? toolCall.function : null;
        if (toolFunction) {
          if (typeof toolFunction.name === "string" && toolFunction.name.trim()) {
            current.name += toolFunction.name;
          }
          if (typeof toolFunction.arguments === "string" && toolFunction.arguments.length > 0) {
            current.argumentsText += toolFunction.arguments;
          }
        }
        toolCallsByIndex.set(index, current);
        if (!sawToolCallDelta) {
          sawToolCallDelta = true;
          yield { type: "tool_call_delta" };
        }
      }
    };

    const buildResult = (): GenericAgentTurnResult => {
      const toolCalls = [...toolCallsByIndex.entries()]
        .sort((left, right) => left[0] - right[0])
        .map(([, toolCall]) => {
          const id = toolCall.id || crypto.randomUUID();
          const name = canonicalizeToolName(toolCall.name, options.tools);
          if (!name) return null;
          let input: Record<string, unknown> = {};
          try {
            const parsed = JSON.parse(toolCall.argumentsText || "{}") as unknown;
            if (isRecord(parsed)) {
              input = parsed;
            }
          } catch {
            input = {};
          }
          return { id, name, input };
        })
        .filter((toolCall): toolCall is GenericAgentTurnResult["toolCalls"][number] =>
          Boolean(toolCall),
        );

      return { text, toolCalls, finishReason };
    };

    const looksLikeSsePayload = (input: string) => {
      for (const rawLine of input.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line) continue;
        return (
          line.startsWith(":") ||
          line.startsWith("data:") ||
          line.startsWith("event:") ||
          line.startsWith("id:") ||
          line.startsWith("retry:")
        );
      }
      return false;
    };

    const consumeSseBuffer = (flush = false) => {
      const working = flush && buffer.length > 0 ? `${buffer}\n` : buffer;
      const lines = working.split("\n");
      buffer = flush ? "" : lines.pop() || "";

      const payloads: string[] = [];
      let done = false;
      for (const rawLine of lines) {
        const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(":") || !trimmed.startsWith("data:")) continue;
        const data = trimmed.slice(5).trimStart();
        if (data === "[DONE]") {
          done = true;
          break;
        }
        payloads.push(data);
      }
      return { payloads, done };
    };

    try {
      const firstRead = await reader.read();
      if (firstRead.done) {
        yield { type: "done", result: buildResult() };
        return;
      }

      timeout.markChunk();
      buffer += decoder.decode(firstRead.value, { stream: true });

      if (!looksLikeSsePayload(buffer)) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          timeout.markChunk();
          buffer += decoder.decode(value, { stream: true });
        }
        const raw = buffer.trim();
        if (!raw) {
          yield { type: "done", result: buildResult() };
          return;
        }
        yield { type: "done", result: parseOpenAIToolCallingResult(JSON.parse(raw), options.tools) };
        return;
      }

      while (true) {
        const { payloads, done } = consumeSseBuffer();
        for (const payload of payloads) {
          for (const event of emitParsedPayload(payload)) {
            yield event;
          }
        }
        if (done) {
          yield { type: "done", result: buildResult() };
          return;
        }

        const next = await reader.read();
        if (next.done) {
          const remaining = consumeSseBuffer(true);
          for (const payload of remaining.payloads) {
            for (const event of emitParsedPayload(payload)) {
              yield event;
            }
          }
          yield { type: "done", result: buildResult() };
          return;
        }
        timeout.markChunk();
        buffer += decoder.decode(next.value, { stream: true });
      }
    } catch (error) {
      rethrowAbortReason(timeout.signal, error);
    } finally {
      timeout.cleanup();
    }
  }
}

export class AnthropicAdapter implements ProviderAdapter {
  private apiKey: string;
  private baseUrl: string;

  constructor(apiKey: string, baseUrl?: string) {
    this.apiKey = apiKey;
    const raw = baseUrl || "https://api.anthropic.com";
    this.baseUrl = raw.replace(/\/+$/, "").replace(/\/v1$/, "");
  }

  async chat(options: ChatOptions): Promise<ChatResponse> {
    const split = splitSystem(options.messages);
    const url = `${this.baseUrl}/v1/messages`;
    const body = JSON.stringify({
      model: options.model,
      ...(split.system ? { system: split.system } : {}),
      messages: split.messages.map((m) => {
        if (typeof m.content === "string") {
          return { role: m.role, content: [{ type: "text", text: m.content || " " }] };
        }
        const blocks = m.content.map((p) => {
          if (p.type === "text") return { type: "text", text: p.text || " " };
          return {
            type: "image",
            source: { type: "base64", media_type: p.mediaType, data: p.dataBase64 },
          };
        });
        return {
          role: m.role,
          content: blocks.length > 0 ? blocks : [{ type: "text", text: " " }],
        };
      }),
      temperature: options.temperature,
      max_tokens: options.maxTokens || 4096,
    });

    const timeout = createRequestTimeoutSignal(
      options.signal,
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    );
    let response: Response | null = null;
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        response = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": this.apiKey,
            "anthropic-version": "2023-06-01",
          },
          body,
          signal: timeout.signal,
        });
        if (response.ok) break;
        if (!shouldRetryStatus(response.status) || attempt === 1) break;
        await sleep(500 * (attempt + 1));
      }
    } catch (error) {
      timeout.cleanup();
      rethrowAbortReason(timeout.signal, error);
    }
    timeout.cleanup();

    if (timeout.signal.aborted && timeout.signal.reason instanceof Error) {
      throw timeout.signal.reason;
    }

    if (!response || !response.ok) {
      const detail = response ? await readErrorDetail(response) : "Request failed";
      if (options.toolChoice && options.toolChoice !== "auto" && shouldRetryWithoutForcedToolChoice(detail)) {
        return this.runToolCallingTurn({
          ...options,
          toolChoice: "auto",
        });
      }
      throw new Error(formatProviderApiError(response?.status, detail));
    }

    const data = (await response.json()) as unknown;
    if (!isRecord(data)) {
      throw new Error("Provider API error: Invalid JSON response");
    }
    const id = typeof data.id === "string" ? data.id : "";
    const model = typeof data.model === "string" ? data.model : options.model;
    const blocks = Array.isArray(data.content) ? data.content : [];
    const first = blocks[0];
    const content = isRecord(first) && typeof first.text === "string" ? first.text : null;
    if (!content) {
      throw new Error("Provider API error: Missing response content");
    }
    const usageRaw = isRecord(data.usage) ? data.usage : null;
    const promptTokens = usageRaw ? toFiniteNumber(usageRaw.input_tokens) : null;
    const completionTokens = usageRaw ? toFiniteNumber(usageRaw.output_tokens) : null;
    return {
      id,
      model,
      content,
      usage:
        promptTokens !== null && completionTokens !== null
          ? {
              promptTokens,
              completionTokens,
              totalTokens: promptTokens + completionTokens,
            }
          : undefined,
    };
  }

  async *chatStream(options: ChatOptions): AsyncGenerator<string> {
    const split = splitSystem(options.messages);
    const url = `${this.baseUrl}/v1/messages`;
    const body = JSON.stringify({
      model: options.model,
      ...(split.system ? { system: split.system } : {}),
      messages: split.messages.map((m) => {
        if (typeof m.content === "string") {
          return { role: m.role, content: [{ type: "text", text: m.content || " " }] };
        }
        const blocks = m.content.map((p) => {
          if (p.type === "text") return { type: "text", text: p.text || " " };
          return {
            type: "image",
            source: { type: "base64", media_type: p.mediaType, data: p.dataBase64 },
          };
        });
        return {
          role: m.role,
          content: blocks.length > 0 ? blocks : [{ type: "text", text: " " }],
        };
      }),
      temperature: options.temperature,
      max_tokens: options.maxTokens || 4096,
      stream: true,
    });

    const timeout = createStreamTimeoutSignal({
      signal: options.signal,
      firstTokenTimeoutMs: options.streamFirstTokenTimeoutMs,
      idleTimeoutMs: options.streamIdleTimeoutMs,
      totalTimeoutMs: options.streamTotalTimeoutMs,
    });
    let response: Response | null = null;
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        response = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": this.apiKey,
            "anthropic-version": "2023-06-01",
          },
          body,
          signal: timeout.signal,
        });
        if (response.ok) break;
        if (!shouldRetryStatus(response.status) || attempt === 1) break;
        await sleep(500 * (attempt + 1));
      }
    } catch (error) {
      timeout.cleanup();
      rethrowAbortReason(timeout.signal, error);
    }

    if (timeout.signal.aborted && timeout.signal.reason instanceof Error) {
      timeout.cleanup();
      throw timeout.signal.reason;
    }

    if (!response || !response.ok) {
      timeout.cleanup();
      const detail = response ? await readErrorDetail(response) : "Request failed";
      if (options.toolChoice && options.toolChoice !== "auto" && shouldRetryWithoutForcedToolChoice(detail)) {
        yield* this.runToolCallingTurnStream({
          ...options,
          toolChoice: "auto",
        });
        return;
      }
      throw new Error(formatProviderApiError(response?.status, detail));
    }

    const reader = response.body?.getReader();
    if (!reader) {
      timeout.cleanup();
      throw new Error("No response body");
    }

    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        timeout.markChunk();
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            const data = line.slice(6);
            if (data === "[DONE]") return;
            try {
              const parsed = JSON.parse(data);
              if (parsed.type === "content_block_delta") {
                const text = parsed?.delta?.text;
                if (typeof text === "string" && text.length > 0) {
                  yield text;
                }
              }
            } catch {
              // Skip invalid JSON
            }
          }
        }
      }
    } catch (error) {
      rethrowAbortReason(timeout.signal, error);
    } finally {
      timeout.cleanup();
    }
  }

  async runToolCallingTurn(options: ToolCallingOptions): Promise<GenericAgentTurnResult> {
    const url = `${this.baseUrl}/v1/messages`;
    const systemMessages = options.messages.filter((message) => message.role === "system");
    const system =
      systemMessages.length > 0
        ? systemMessages.map((message) => message.content).join("\n\n")
        : undefined;

    const body = JSON.stringify({
      model: options.model,
      ...(system ? { system } : {}),
      messages: options.messages
        .filter((message) => message.role !== "system")
        .map((message) => {
          if (message.role === "user") {
            return {
              role: "user",
              content: [{ type: "text", text: message.content || " " }],
            };
          }
          if (message.role === "assistant") {
            const contentBlocks: Array<Record<string, unknown>> = [];
            if (message.content) {
              contentBlocks.push({ type: "text", text: message.content });
            }
            for (const toolCall of message.toolCalls || []) {
              contentBlocks.push({
                type: "tool_use",
                id: toolCall.id,
                name: toolCall.name,
                input: toolCall.input,
              });
            }
            return {
              role: "assistant",
              content: contentBlocks.length > 0 ? contentBlocks : [{ type: "text", text: " " }],
            };
          }
          if (message.role !== "tool") {
            return {
              role: "user",
              content: [{ type: "text", text: message.content || " " }],
            };
          }
          return {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: message.toolCallId,
                content: message.content || " ",
                ...(message.isError ? { is_error: true } : {}),
              },
            ],
          };
        }),
      tools: options.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema,
      })),
      tool_choice:
        options.toolChoice && options.toolChoice !== "auto"
          ? { type: "tool", name: options.toolChoice.name }
          : { type: "auto" },
      max_tokens: 4096,
    });

    const timeout = createRequestTimeoutSignal(
      options.signal,
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    );
    let response: Response | null = null;
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        response = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": this.apiKey,
            "anthropic-version": "2023-06-01",
          },
          body,
          signal: timeout.signal,
        });
        if (response.ok) break;
        if (!shouldRetryStatus(response.status) || attempt === 1) break;
        await sleep(500 * (attempt + 1));
      }
    } catch (error) {
      timeout.cleanup();
      rethrowAbortReason(timeout.signal, error);
    }
    timeout.cleanup();

    if (timeout.signal.aborted && timeout.signal.reason instanceof Error) {
      throw timeout.signal.reason;
    }

    if (!response || !response.ok) {
      const detail = response ? await readErrorDetail(response) : "Request failed";
      if (options.toolChoice && options.toolChoice !== "auto" && shouldRetryWithoutForcedToolChoice(detail)) {
        return this.runToolCallingTurn({
          ...options,
          toolChoice: "auto",
        });
      }
      throw new Error(formatProviderApiError(response?.status, detail));
    }

    const data = (await response.json()) as unknown;
    if (!isRecord(data)) {
      throw new Error("Provider API error: Invalid JSON response");
    }

    const contentBlocks = Array.isArray(data.content) ? data.content : [];
    const text = contentBlocks
      .filter(
        (block): block is { type?: string; text?: string } =>
          isRecord(block) && block.type === "text" && typeof block.text === "string",
      )
      .map((block) => block.text ?? "")
      .join("");

    const toolCalls = contentBlocks
      .map((block) => {
        if (!isRecord(block) || block.type !== "tool_use") {
          return null;
        }
        const id = typeof block.id === "string" ? block.id : crypto.randomUUID();
        const name =
          typeof block.name === "string" ? canonicalizeToolName(block.name, options.tools) : "";
        if (!name) return null;
        const input = isRecord(block.input) ? block.input : {};
        return { id, name, input };
      })
      .filter((toolCall): toolCall is GenericAgentTurnResult["toolCalls"][number] =>
        Boolean(toolCall),
      );

    return {
      text,
      toolCalls,
      finishReason: typeof data.stop_reason === "string" ? data.stop_reason : null,
    };
  }
}

export function createAdapter(protocol: string, apiKey: string, baseUrl?: string): ProviderAdapter {
  const normalized = (protocol || "").trim().toLowerCase() as AdapterProtocol | string;
  if (normalized === "anthropic") {
    return new AnthropicAdapter(apiKey, baseUrl);
  }
  if (normalized === "google") {
    throw new Error("Unsupported provider: google");
  }
  // Default to OpenAI-compatible (e.g. openai/deepseek/qwen/doubao/others with OpenAI-compatible baseUrl).
  return new OpenAIAdapter(apiKey, baseUrl);
}

export function supportsToolCalling(adapter: ProviderAdapter): adapter is ToolCallingAdapter {
  return typeof (adapter as Partial<ToolCallingAdapter>).runToolCallingTurn === "function";
}

export function supportsStreamingToolCalling(
  adapter: ProviderAdapter,
): adapter is StreamingToolCallingAdapter {
  return typeof (adapter as Partial<StreamingToolCallingAdapter>).runToolCallingTurnStream === "function";
}
