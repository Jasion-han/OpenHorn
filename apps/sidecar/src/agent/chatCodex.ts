import { sanitizeChildEnv } from "./childEnv";
import { type AgentEvent, buildUsageEvent, toCount } from "./events";

/**
 * Token counts off a `codex exec --json` line, or null for any other event.
 *
 * Shape verified against codex-cli 0.145.0:
 *   {"type":"turn.completed","usage":{"input_tokens":16072,
 *     "cached_input_tokens":4480,"cache_write_input_tokens":0,
 *     "output_tokens":17,"reasoning_output_tokens":10}}
 *
 * snake_case here, where the app-server transport used by codex.ts sends the
 * same numbers in camelCase — hence two readers rather than one.
 *
 * `cached_input_tokens` is a subset of `input_tokens` (the probe's total was
 * input + output with the cache field non-zero), so it is not added in.
 */
export function readCodexExecUsage(
  event: unknown,
): { promptTokens: number; completionTokens: number } | null {
  if (typeof event !== "object" || event === null) return null;
  const record = event as Record<string, unknown>;
  if (record.type !== "turn.completed") return null;
  const usage = (record.usage ?? {}) as Record<string, unknown>;
  return {
    promptTokens: toCount(usage.input_tokens),
    completionTokens: toCount(usage.output_tokens),
  };
}

export type RunCodexChatInput = {
  model: string;
  prompt: string;
  abortController: AbortController;
  onEvent: (event: AgentEvent) => void;
};

export async function runCodexChat(input: RunCodexChatInput): Promise<void> {
  const codexPath = await findCodexBinary();
  if (!codexPath) {
    input.onEvent({
      type: "error",
      content: "未找到 Codex CLI，请先安装: npm install -g @openai/codex",
    });
    return;
  }

  const proc = Bun.spawn(
    [
      codexPath,
      "exec",
      input.prompt,
      "--model",
      input.model,
      "--json",
      "-c",
      'approval_policy="never"',
    ],
    {
      stdin: new Blob([""]),
      stdout: "pipe",
      stderr: "pipe",
      signal: input.abortController.signal,
      // Codex runs with approval_policy="never" and a full shell — it must not
      // inherit our handshake token or provider keys. Mirrors codex.ts.
      env: sanitizeChildEnv({ ...process.env }),
    },
  );

  // Drain stderr concurrently from the moment the child spawns. Codex can emit
  // >64KB of JSON logs on stderr; if we only read it after exit, the pipe buffer
  // fills, the child blocks on write, and our stdout reader.read() hangs forever.
  const stderrPromise = new Response(proc.stderr).text();

  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let promptTokens = 0;
  let completionTokens = 0;

  const emitUsage = () => {
    const usage = buildUsageEvent(promptTokens, completionTokens);
    if (usage) input.onEvent(usage);
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          if (event.type === "item.completed" && event.item?.type === "agent_message") {
            const text = event.item.text || "";
            if (text) {
              input.onEvent({ type: "text", content: text });
            }
          }
          const usage = readCodexExecUsage(event);
          if (usage) {
            promptTokens = usage.promptTokens;
            completionTokens = usage.completionTokens;
          }
        } catch {
          // skip non-JSON lines
        }
      }
    }
  } catch (error) {
    // Reported on the way out of every exit, not just the clean one: a turn that
    // was cancelled or errored partway still spent whatever it had spent.
    emitUsage();
    if (input.abortController.signal.aborted) {
      input.onEvent({ type: "done" });
      return;
    }
    const msg = error instanceof Error ? error.message : "Codex chat error";
    input.onEvent({ type: "error", content: msg });
    return;
  }

  const exitCode = await proc.exited;
  emitUsage();
  if (exitCode !== 0) {
    const stderr = await stderrPromise;
    const errMsg = stderr
      .trim()
      .split("\n")
      .filter((l) => !l.includes("ERROR rmcp"))
      .join("\n")
      .trim();
    if (errMsg) {
      input.onEvent({ type: "error", content: errMsg });
      return;
    }
  }

  input.onEvent({ type: "done" });
}

async function findCodexBinary(): Promise<string | null> {
  const { existsSync } = await import("node:fs");
  for (const p of ["/opt/homebrew/bin/codex", "/usr/local/bin/codex"]) {
    if (existsSync(p)) return p;
  }
  try {
    const proc = Bun.spawn(["which", "codex"], { stdout: "pipe", stderr: "pipe" });
    if ((await proc.exited) === 0) {
      const path = (await new Response(proc.stdout).text()).trim();
      if (path) return path;
    }
  } catch {}
  return null;
}
