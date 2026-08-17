/** A file location referenced by a tool call (ACP `locations[]`). */
export interface AgentToolLocation {
  path: string;
  line?: number;
}

/** A file diff produced by a tool call (ACP `content[]{type:"diff"}`). */
export interface AgentToolDiff {
  path: string;
  oldText: string | null;
  newText: string;
}

export type AgentEvent =
  | { type: "text"; content: string }
  | { type: "final_text"; content: string }
  | { type: "thinking"; content: string }
  | { type: "tool_start"; toolName?: string; toolInput?: unknown }
  | { type: "tool_result"; content?: string }
  | { type: "user_message"; userMessageId: string }
  /** Token counts for the turn, emitted just before `done` when the provider reported them. */
  | {
      type: "usage";
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
      /** ACP usage_update: context window total size. */
      contextSize?: number;
      /** ACP usage_update: cumulative session cost. */
      cost?: { amount: number; currency: string };
    }
  | { type: "done" }
  | { type: "error"; content: string }
  /** ACP-specific: rich tool call with lifecycle status, kind, locations, diff. */
  | {
      type: "tool_call_detail";
      toolCallId: string;
      title: string;
      kind?: string;
      status: string;
      locations?: AgentToolLocation[];
      rawInput?: Record<string, unknown>;
      diff?: AgentToolDiff;
      content?: string;
    }
  /** ACP-specific: agent execution plan (full replacement on each emission). */
  | {
      type: "plan";
      entries: Array<{ content: string; priority: string; status: string }>;
    }
  /** ACP-specific: agent identity from initialize response. */
  | {
      type: "agent_info";
      agentName: string;
      agentVersion: string;
    }
  /** ACP-specific: dynamic model list from session config options. */
  | {
      type: "available_models";
      models: Array<{ id: string; name: string }>;
    };

type SdkMessage = {
  type: string;
  [key: string]: unknown;
};

export function convertSdkEvent(message: SdkMessage): AgentEvent | AgentEvent[] | null {
  if (message.type === "user") {
    const uuid = typeof message.uuid === "string" ? message.uuid : null;
    if (uuid) return { type: "user_message", userMessageId: uuid };
  }

  if (message.type === "assistant" && message.message && typeof message.message === "object") {
    const msg = message.message as {
      content?: Array<{ type?: string; text?: string; name?: string; input?: unknown }>;
    };
    const events: AgentEvent[] = [];
    for (const block of msg.content || []) {
      if (block.type === "tool_use") {
        events.push({
          type: "tool_start",
          toolName: typeof block.name === "string" ? block.name : undefined,
          toolInput: block.input,
        });
      }
    }
    return events.length > 0 ? events : null;
  }

  if (message.type === "stream_event" && message.event && typeof message.event === "object") {
    const event = message.event as { type?: string; delta?: { text?: string } };
    if (event.type === "content_block_delta" && event.delta?.text) {
      return { type: "final_text", content: event.delta.text };
    }
  }

  if (message.type === "text" && typeof message.text === "string") {
    return null;
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

  if (message.type === "result") {
    return convertResultUsage(message);
  }

  return null;
}

export function toCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * The one place a `usage` event gets built, so every runtime agrees on what the
 * two numbers mean and on when there is nothing worth reporting.
 *
 * `promptTokens` is the WHOLE input the turn processed, cache included. Each
 * runtime has to reach that figure its own way, because the providers disagree
 * on whether their "input" field already counts the cache:
 *   - Anthropic / pi-ai exclude it, so the cache buckets get added (see
 *     `convertResultUsage`, and direct.ts).
 *   - Codex includes it, so adding `cachedInputTokens` would count it twice
 *     (verified on codex-cli 0.145.0: totalTokens === inputTokens + outputTokens
 *     with cachedInputTokens well above zero).
 *
 * All-zero means "the provider said nothing" rather than "this turn was free" —
 * gateways routinely omit usage entirely. Returning null keeps the bubble
 * showing no token line at all instead of a confident `0 tokens`.
 */
export function buildUsageEvent(promptTokens: number, completionTokens: number): AgentEvent | null {
  if (promptTokens === 0 && completionTokens === 0) return null;
  return {
    type: "usage",
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
  };
}

/**
 * Token counts for the whole agent turn, carried on the SDK's terminal `result`
 * message.
 *
 * `promptTokens` sums the cached buckets alongside `input_tokens`. Anthropic
 * reports cache reads/writes separately and `input_tokens` counts only what was
 * NOT served from cache — for an agent loop, where every step resends the whole
 * transcript, that field alone reports a small fraction of what the turn
 * actually processed. The panel is there to show the size of the turn, so it
 * gets the full input.
 */
export function convertResultUsage(message: SdkMessage): AgentEvent | null {
  const usage = message.usage;
  if (!usage || typeof usage !== "object") return null;
  const raw = usage as Record<string, unknown>;

  const promptTokens =
    toCount(raw.input_tokens) +
    toCount(raw.cache_creation_input_tokens) +
    toCount(raw.cache_read_input_tokens);
  const completionTokens = toCount(raw.output_tokens);

  return buildUsageEvent(promptTokens, completionTokens);
}
