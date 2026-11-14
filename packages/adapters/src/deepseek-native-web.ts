import type { ProviderChatMetadata, ProviderChatState } from "shared/types";
import type { ChatMessage } from "./adapters";

export const PROVIDER_CHAT_STATE_MAX_BYTES = 256 * 1024;
const MODELS = new Set(["deepseek-flash", "deepseek-v4-flash-vision-exp"]);
type Identity = { origin: string; model: string };
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** No suffix/substring matching: private fields and encrypted state stay at their source. */
export function deepseekNativeWebIdentity(
  baseUrl: string | null | undefined,
  model: string,
): Identity | null {
  if (!baseUrl || !MODELS.has(model)) return null;
  try {
    const url = new URL(baseUrl);
    if (
      url.origin !== "https://api.deepseek.com" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !["/", "/v1", "/v1/"].includes(url.pathname)
    )
      return null;
    return { origin: url.origin, model };
  } catch {
    return null;
  }
}

export function supportsDeepSeekNativeWeb(
  protocol: string,
  baseUrl: string | null | undefined,
  model: string,
): boolean {
  return protocol === "openai" && deepseekNativeWebIdentity(baseUrl, model) !== null;
}

/** Budget only state that the selected destination can replay; never alter stored messages. */
export function filterChatProviderState(
  messages: ChatMessage[],
  protocol: string,
  baseUrl: string | null | undefined,
  model: string,
): ChatMessage[] {
  const identity = protocol === "openai" ? deepseekNativeWebIdentity(baseUrl, model) : null;
  return messages.map((message) => {
    if (!("providerState" in message)) return message;
    if (
      identity &&
      message.role === "assistant" &&
      validateProviderChatState(message.providerState, identity)
    ) {
      return message;
    }
    const filtered = { ...message };
    delete filtered.providerState;
    return filtered;
  });
}

function boundedJson(value: unknown, depth = 0, budget = { nodes: 20000 }): boolean {
  if (depth > 16 || --budget.nodes < 0) return false;
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") return value.length <= PROVIDER_CHAT_STATE_MAX_BYTES;
  if (Array.isArray(value))
    return value.length <= 500 && value.every((v) => boundedJson(v, depth + 1, budget));
  if (!record(value) || Object.getPrototypeOf(value) !== Object.prototype) return false;
  return Object.entries(value).every(
    ([key, v]) =>
      !["__proto__", "prototype", "constructor"].includes(key) && boundedJson(v, depth + 1, budget),
  );
}

/** Accepts DB JSON or an untrusted object. Reject the entire state, never shorten signatures. */
export function validateProviderChatState(
  value: unknown,
  identity?: Identity,
): ProviderChatState | null {
  try {
    if (typeof value === "string") {
      if (value.length > PROVIDER_CHAT_STATE_MAX_BYTES) return null;
      value = JSON.parse(value);
    }
    if (
      !record(value) ||
      value.provider !== "deepseek" ||
      typeof value.origin !== "string" ||
      typeof value.model !== "string"
    )
      return null;
    const source = deepseekNativeWebIdentity(value.origin, value.model);
    if (
      !source ||
      value.origin !== source.origin ||
      (identity && (source.origin !== identity.origin || source.model !== identity.model))
    )
      return null;
    if (
      !Array.isArray(value.serverToolCalls) ||
      value.serverToolCalls.length > 32 ||
      !boundedJson(value.serverToolCalls)
    )
      return null;
    let count = 0;
    for (const step of value.serverToolCalls) {
      if (
        !record(step) ||
        !Number.isInteger(step.index) ||
        (step.index as number) < 0 ||
        !Array.isArray(step.calls) ||
        step.calls.length > 80 ||
        (step.reasoning_content !== undefined && typeof step.reasoning_content !== "string")
      )
        return null;
      for (const call of step.calls) {
        if (
          ++count > 80 ||
          !record(call) ||
          !Number.isInteger(call.index) ||
          (call.index as number) < 0 ||
          typeof call.id !== "string" ||
          !call.id ||
          call.id.length > 256 ||
          !["deepseek_web_search", "deepseek_read_url"].includes(String(call.type)) ||
          !["search", "deep_search", "read_link", "image_search", "deep_image_search"].includes(
            String(call.kind),
          ) ||
          !["completed", "failed"].includes(String(call.status)) ||
          !record(call.action) ||
          !["search", "open_page", "find_in_page", "read_link"].includes(
            String(call.action.type),
          ) ||
          (call.signature !== undefined && typeof call.signature !== "string")
        )
          return null;
      }
    }
    const state = {
      provider: "deepseek",
      origin: source.origin,
      model: source.model,
      serverToolCalls: value.serverToolCalls,
    };
    const json = JSON.stringify(state);
    if (new TextEncoder().encode(json).length > PROVIDER_CHAT_STATE_MAX_BYTES) return null;
    return JSON.parse(json) as ProviderChatState;
  } catch {
    return null;
  }
}

export function safeCitationUrl(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    value.length > 4096 ||
    [...value].some((character) => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127)
  )
    return null;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}

/** Also used at the persistence boundary; no HTML, image URLs or codepoint offsets. */
export function validateChatCitations(
  value: unknown,
): NonNullable<ProviderChatMetadata["citations"]> | null {
  if (!Array.isArray(value) || value.length > 100) return null;
  const result: NonNullable<ProviderChatMetadata["citations"]> = [];
  for (const item of value) {
    if (!record(item)) return null;
    const url = safeCitationUrl(item.url);
    if (!url) continue;
    if (result.some((source) => source.url === url)) continue;
    result.push({
      url,
      title: typeof item.title === "string" ? item.title.slice(0, 1000) : url,
      ...(typeof item.snippet === "string" ? { snippet: item.snippet.slice(0, 2000) } : {}),
      ...(typeof item.publishedDate === "string"
        ? { publishedDate: item.publishedDate.slice(0, 100) }
        : {}),
    });
  }
  return result;
}

export class DeepSeekChatMetadata {
  private metadata: ProviderChatMetadata = { citations: [], steps: [] };
  constructor(
    private identity: Identity,
    private callback?: (metadata: ProviderChatMetadata) => void,
    private signal?: AbortSignal,
  ) {}
  private emit() {
    if (!this.signal?.aborted) this.callback?.(JSON.parse(JSON.stringify(this.metadata)));
  }
  consume(choice: unknown, usage?: unknown) {
    if (this.signal?.aborted) return;
    let changed = false;
    if (record(usage) && record(usage.server_tool_use)) {
      const u = usage.server_tool_use;
      const count = (v: unknown) =>
        typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : 0;
      this.metadata.toolUsage = {
        search: count(u.tool_search),
        fetch: count(u.tool_fetch),
        imageSearch: count(u.tool_image_search),
      };
      changed = true;
    }
    if (record(choice)) {
      const event = choice.server_tool_event;
      if (
        record(event) &&
        ["call_started", "call_completed"].includes(String(event.type)) &&
        record(event.call)
      ) {
        this.upsertCall(event.call, event.type === "call_started" ? "in_progress" : undefined);
        changed = true;
      }
      const delta = record(choice.delta)
        ? choice.delta
        : record(choice.message)
          ? choice.message
          : null;
      if (delta && typeof choice.finish_reason === "string") {
        if (delta.server_tool_calls !== undefined) {
          const state = validateProviderChatState({
            provider: "deepseek",
            ...this.identity,
            serverToolCalls: delta.server_tool_calls,
          });
          if (state) {
            this.metadata.providerState = state;
            for (const step of state.serverToolCalls)
              for (const call of step.calls as Record<string, unknown>[]) this.upsertCall(call);
          }
          changed = true;
        }
        if (Array.isArray(delta.annotations)) {
          this.metadata.citations =
            validateChatCitations(
              delta.annotations
                .filter((a) => record(a) && a.type === "url_citation")
                .map((a) => a.url_citation),
            ) ?? [];
          changed = true;
        }
      }
      if (choice.finish_reason === "content_filter") {
        // This is an independent update even if the last frame had no tools/annotations.
        this.metadata.refused = true;
        this.metadata.citations = [];
        changed = true;
      }
    }
    if (changed) this.emit();
  }
  private upsertCall(call: Record<string, unknown>, status?: string) {
    if (typeof call.id !== "string" || call.id.length > 256 || !record(call.action)) return;
    const action = call.action;
    if (!["search", "open_page", "find_in_page", "read_link"].includes(String(action.type))) return;
    const page = record(call.page) ? call.page : {};
    const url = safeCitationUrl(action.url ?? page.url);
    const queries = Array.isArray(action.queries)
      ? action.queries
          .filter((v): v is string => typeof v === "string")
          .slice(0, 10)
          .join("; ")
          .slice(0, 2000)
      : undefined;
    const step = {
      id: call.id,
      action: String(action.type),
      status: status ?? (call.status === "completed" ? "completed" : "failed"),
      ...(queries ? { query: queries } : {}),
      ...(url ? { url } : {}),
      ...(typeof page.title === "string" ? { title: page.title.slice(0, 1000) } : {}),
    };
    const steps = this.metadata.steps ?? [];
    const index = steps.findIndex((item) => item.id === step.id);
    if (index >= 0) steps[index] = { ...steps[index], ...step };
    else if (steps.length < 80) steps.push(step);
    this.metadata.steps = steps;
  }
}
