/**
 * Turn accumulator shared by every conversation importer (Claude Code, Codex,
 * ChatGPT export, Claude.ai export).
 *
 * One assistant reply in those sources is a run of pieces between two user
 * prompts: thinking, interim text, tool calls, tool results, more text… The
 * importers feed those pieces in source order; `flush()` folds them into one
 * message shaped exactly like a native OpenHorn agent turn — every piece but
 * the final text becomes an `agentRun.steps` entry (interim text as
 * `reasoning`, mirroring what the sidecar emits), and the last text is the
 * message body. Nothing is dropped or truncated: the desktop run panel already
 * renders each step type in full.
 */

export type ImportStep =
  | { type: "thinking"; content: string }
  | { type: "reasoning"; content: string }
  | { type: "tool_start"; toolName: string; toolInput?: unknown; toolCallId?: string }
  | { type: "tool_result"; toolName?: string; content: string; toolCallId?: string }
  | { type: "error"; toolName?: string; content: string; toolCallId?: string };

export interface ImportUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ImportTurn {
  content: string;
  steps: ImportStep[];
  model: string | null;
  usage: ImportUsage | null;
  createdAt: number;
}

type TurnItem = ImportStep | { type: "text"; content: string };

export function addImportUsage(a: ImportUsage | null, b: ImportUsage | null): ImportUsage | null {
  if (!a) return b;
  if (!b) return a;
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    totalTokens: a.totalTokens + b.totalTokens,
  };
}

export class ImportTurnBuilder {
  private items: TurnItem[] = [];
  private model: string | null = null;
  private usage: ImportUsage | null = null;
  private createdAt: number | null = null;
  /** call id → tool name, so a result can carry the name of the call it answers. */
  private callNames = new Map<string, string>();

  get isEmpty(): boolean {
    return this.items.length === 0;
  }

  /** First piece's timestamp wins; later pieces only extend the turn. */
  touch(createdAt: number): void {
    if (this.createdAt === null) this.createdAt = createdAt;
  }

  setModel(model: string | null): void {
    if (model) this.model = model;
  }

  addUsage(usage: ImportUsage | null): void {
    this.usage = addImportUsage(this.usage, usage);
  }

  /**
   * Adjacent text pieces (nothing but text between them) are one passage: a
   * reply split across API messages with no tool call in between, or several
   * text blocks of one message. They join with a blank line so the body is
   * one markdown document rather than a stray `reasoning` step per fragment.
   */
  text(content: string): void {
    if (!content.trim()) return;
    const last = this.items[this.items.length - 1];
    if (last && last.type === "text") {
      last.content = `${last.content.trimEnd()}\n\n${content.trimStart()}`;
      return;
    }
    this.items.push({ type: "text", content });
  }

  thinking(content: string): void {
    if (!content.trim()) return;
    this.items.push({ type: "thinking", content });
  }

  toolStart(toolName: string, toolInput?: unknown, toolCallId?: string): void {
    if (toolCallId) this.callNames.set(toolCallId, toolName);
    this.items.push({
      type: "tool_start",
      toolName,
      ...(toolInput === undefined ? {} : { toolInput }),
      ...(toolCallId ? { toolCallId } : {}),
    });
  }

  toolResult(
    content: string,
    opts: { toolCallId?: string; toolName?: string; isError?: boolean } = {},
  ): void {
    const toolName =
      opts.toolName ?? (opts.toolCallId ? this.callNames.get(opts.toolCallId) : undefined);
    this.items.push({
      type: opts.isError ? "error" : "tool_result",
      content,
      ...(toolName ? { toolName } : {}),
      ...(opts.toolCallId ? { toolCallId: opts.toolCallId } : {}),
    });
  }

  error(content: string): void {
    if (!content.trim()) return;
    this.items.push({ type: "error", content });
  }

  /**
   * Folds the collected pieces into one turn, or null when nothing was
   * collected. The last text piece is the body; every other piece keeps its
   * place in `steps`, interim text as `reasoning`.
   */
  flush(fallbackCreatedAt: number): ImportTurn | null {
    if (this.items.length === 0) return null;
    let lastText = -1;
    for (let i = this.items.length - 1; i >= 0; i--) {
      if (this.items[i].type === "text") {
        lastText = i;
        break;
      }
    }
    const steps: ImportStep[] = [];
    for (let i = 0; i < this.items.length; i++) {
      const item = this.items[i];
      if (item.type === "text") {
        if (i !== lastText) steps.push({ type: "reasoning", content: item.content });
        continue;
      }
      steps.push(item);
    }
    const content = lastText >= 0 ? (this.items[lastText] as { content: string }).content : "";
    const turn: ImportTurn = {
      content,
      steps,
      model: this.model,
      usage: this.usage,
      createdAt: this.createdAt ?? fallbackCreatedAt,
    };
    this.items = [];
    this.model = null;
    this.usage = null;
    this.createdAt = null;
    this.callNames.clear();
    return turn;
  }
}

/**
 * `messages.agent_run` JSON for an imported turn — same shape and wording the
 * legacy agent-session migration writes, so the desktop treats both alike.
 * Returns null for a plain text turn so `agentRun` stays NULL like a chat row.
 */
export function buildImportedAgentRun(steps: ImportStep[]): string | null {
  if (steps.length === 0) return null;
  const toolCount = steps.filter((step) => step.type === "tool_start").length;
  const summary = toolCount > 0 ? `Agent 已调用 ${toolCount} 个工具` : "Agent 已完成本轮执行";
  return JSON.stringify({ status: "completed", summary, toolCount, steps });
}

/**
 * Text of a tool result's content, which providers write as a string or as a
 * list of text / image blocks. Images are not embedded (a session's screenshots
 * run to tens of MB of base64); their presence is kept as a marker so the
 * step still says what came back.
 */
export function toolResultContentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) {
    if (content === null || content === undefined) return "";
    try {
      return JSON.stringify(content);
    } catch {
      return String(content);
    }
  }
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === "string") {
      parts.push(block);
      continue;
    }
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    if (
      (b.type === "text" || b.type === "input_text" || b.type === "output_text") &&
      typeof b.text === "string"
    ) {
      parts.push(b.text);
      continue;
    }
    if (b.type === "image") {
      const source = b.source as Record<string, unknown> | undefined;
      const mediaType = typeof source?.media_type === "string" ? source.media_type : "image";
      const data = typeof source?.data === "string" ? source.data : "";
      const bytes = Math.floor((data.length * 3) / 4);
      parts.push(bytes > 0 ? `[图片 ${mediaType} ${formatBytes(bytes)}]` : `[图片 ${mediaType}]`);
      continue;
    }
    try {
      parts.push(JSON.stringify(block));
    } catch {
      /* unserialisable block: nothing to show */
    }
  }
  return parts.join("\n");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** JSON arguments string → object when it parses, else the raw string kept. */
export function parseToolArguments(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return raw;
  }
}
