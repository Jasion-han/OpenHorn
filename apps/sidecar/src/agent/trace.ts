import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AgentEvent } from "./events";

interface TraceEntry {
  ts: number;
  runId: string;
  type: string;
  toolName?: string;
  toolInput?: unknown;
  content?: string;
  tokens?: { prompt: number; completion: number; total: number };
  error?: string;
}

export function createTraceWriter(cwd: string, runId: string) {
  const dir = join(cwd, ".openhorn", "runs");
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, `${runId}.jsonl`);

  return function writeTrace(event: AgentEvent) {
    let entry: TraceEntry | null = null;

    switch (event.type) {
      case "tool_start":
        entry = {
          ts: Date.now(),
          runId,
          type: "tool_start",
          toolName: event.toolName,
          toolInput: event.toolInput,
        };
        break;
      case "tool_result":
        entry = {
          ts: Date.now(),
          runId,
          type: "tool_result",
          content: event.content
            ? event.content.length > 2000
              ? event.content.slice(0, 2000) + "…"
              : event.content
            : undefined,
        };
        break;
      case "usage":
        entry = {
          ts: Date.now(),
          runId,
          type: "usage",
          tokens: {
            prompt: event.promptTokens,
            completion: event.completionTokens,
            total: event.totalTokens,
          },
        };
        break;
      case "error":
        entry = {
          ts: Date.now(),
          runId,
          type: "error",
          error: event.content,
        };
        break;
      case "done":
        entry = { ts: Date.now(), runId, type: "done" };
        break;
    }

    if (entry) {
      try {
        appendFileSync(filePath, JSON.stringify(entry) + "\n");
      } catch {
        // best-effort: trace failure must never crash the agent
      }
    }
  };
}
