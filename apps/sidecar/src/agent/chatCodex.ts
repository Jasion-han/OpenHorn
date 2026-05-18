import type { AgentEvent } from "./events";

export type RunCodexChatInput = {
  model: string;
  prompt: string;
  abortController: AbortController;
  onEvent: (event: AgentEvent) => void;
};

export async function runCodexChat(input: RunCodexChatInput): Promise<void> {
  const codexPath = await findCodexBinary();
  if (!codexPath) {
    input.onEvent({ type: "error", content: "未找到 Codex CLI，请先安装: npm install -g @openai/codex" });
    return;
  }

  const proc = Bun.spawn(
    [codexPath, "exec", input.prompt, "--model", input.model, "--json", "-c", "approval_policy=\"never\""],
    {
      stdin: new Blob([""]),
      stdout: "pipe",
      stderr: "pipe",
      signal: input.abortController.signal,
    },
  );

  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

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
        } catch {
          // skip non-JSON lines
        }
      }
    }
  } catch (error) {
    if (input.abortController.signal.aborted) {
      input.onEvent({ type: "done" });
      return;
    }
    const msg = error instanceof Error ? error.message : "Codex chat error";
    input.onEvent({ type: "error", content: msg });
    return;
  }

  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    const errMsg = stderr.trim().split("\n").filter(l => !l.includes("ERROR rmcp")).join("\n").trim();
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
    if (await proc.exited === 0) {
      const path = (await new Response(proc.stdout).text()).trim();
      if (path) return path;
    }
  } catch {}
  return null;
}
