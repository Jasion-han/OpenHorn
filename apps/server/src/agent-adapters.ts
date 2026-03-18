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

function shouldRetryStatus(status: number) {
  return status === 429 || status === 502 || status === 503 || status === 504;
}

async function readErrorDetail(response: Response): Promise<string> {
  const contentType = response.headers.get("content-type") || "";
  try {
    if (contentType.includes("application/json")) {
      const data = (await response.json().catch(() => null)) as unknown;
      const msg = (() => {
        if (!isRecord(data)) return null;
        const err = data.error;
        if (isRecord(err) && typeof err.message === "string") return err.message;
        if (typeof data.message === "string") return data.message;
        if (typeof data.error === "string") return data.error;
        if (typeof data.detail === "string") return data.detail;
        return null;
      })();
      if (typeof msg === "string" && msg.trim()) return msg.trim().slice(0, 800);
      return JSON.stringify(data).slice(0, 800);
    }
  } catch {
    // ignore
  }
  const text = await response.text().catch(() => "");
  return (text || response.statusText || "Request failed").toString().slice(0, 800);
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

export class OpenAIAdapter implements ProviderAdapter {
  private apiKey: string;
  private baseUrl: string;

  constructor(apiKey: string, baseUrl?: string) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl || "https://api.openai.com/v1";
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

    let response: Response | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body,
      });
      if (response.ok) break;
      if (!shouldRetryStatus(response.status) || attempt === 1) break;
      await sleep(500 * (attempt + 1));
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

    let response: Response | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body,
      });
      if (response.ok) break;
      if (!shouldRetryStatus(response.status) || attempt === 1) break;
      await sleep(500 * (attempt + 1));
    }

    if (!response || !response.ok) {
      const detail = response ? await readErrorDetail(response) : "Request failed";
      const status = response?.status ? ` (${response.status})` : "";
      throw new Error(`OpenAI API error${status}: ${detail}`);
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error("No response body");
    }

    const decoder = new TextDecoder();
    let buffer = "";

    // Some proxies incorrectly label streaming responses as application/json.
    // Sniff the first chunk: if it looks like SSE ("data:" lines), parse as stream.
    const firstRead = await reader.read();
    if (firstRead.done) return;

    const firstChunkText = decoder.decode(firstRead.value, { stream: true });
    buffer += firstChunkText;

    const looksLikeSse =
      buffer.startsWith("data:") || buffer.includes("\ndata:") || buffer.includes("\r\ndata:");

    if (!looksLikeSse) {
      // Fallback: treat as a non-streamed JSON/text response and emit once.
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
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
        // As a last resort, yield raw text.
        yield raw;
      }
      return;
    }

    while (true) {
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (line.startsWith("data: ")) {
          const data = line.slice(6);
          if (data === "[DONE]") return;
          try {
            const parsed = JSON.parse(data);
            const content = parsed.choices[0]?.delta?.content;
            if (content) yield content;
          } catch {
            // Skip invalid JSON
          }
        }
      }

      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
    }
  }
}

export class AnthropicAdapter implements ProviderAdapter {
  private apiKey: string;
  private baseUrl: string;

  constructor(apiKey: string, baseUrl?: string) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl || "https://api.anthropic.com";
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
      max_tokens: options.maxTokens || 1024,
    });

    let response: Response | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": this.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body,
      });
      if (response.ok) break;
      if (!shouldRetryStatus(response.status) || attempt === 1) break;
      await sleep(500 * (attempt + 1));
    }

    if (!response || !response.ok) {
      const detail = response ? await readErrorDetail(response) : "Request failed";
      const status = response?.status ? ` (${response.status})` : "";
      throw new Error(`Anthropic API error${status}: ${detail}`);
    }

    const data = (await response.json()) as unknown;
    if (!isRecord(data)) {
      throw new Error("Anthropic API error: Invalid JSON response");
    }
    const id = typeof data.id === "string" ? data.id : "";
    const model = typeof data.model === "string" ? data.model : options.model;
    const blocks = Array.isArray(data.content) ? data.content : [];
    const first = blocks[0];
    const content = isRecord(first) && typeof first.text === "string" ? first.text : null;
    if (!content) {
      throw new Error("Anthropic API error: Missing response content");
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
      max_tokens: options.maxTokens || 1024,
      stream: true,
    });

    let response: Response | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": this.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body,
      });
      if (response.ok) break;
      if (!shouldRetryStatus(response.status) || attempt === 1) break;
      await sleep(500 * (attempt + 1));
    }

    if (!response || !response.ok) {
      const detail = response ? await readErrorDetail(response) : "Request failed";
      const status = response?.status ? ` (${response.status})` : "";
      throw new Error(`Anthropic API error${status}: ${detail}`);
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error("No response body");
    }

    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

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
  }
}

export function createAdapter(provider: string, apiKey: string, baseUrl?: string): ProviderAdapter {
  const normalized = (provider || "").trim().toLowerCase();
  if (normalized === "anthropic") {
    return new AnthropicAdapter(apiKey, baseUrl);
  }
  if (normalized === "google") {
    throw new Error("Unsupported provider: google");
  }
  // Default to OpenAI-compatible (e.g. openai/deepseek/qwen/doubao/others with OpenAI-compatible baseUrl).
  return new OpenAIAdapter(apiKey, baseUrl);
}
