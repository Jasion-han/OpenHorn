import { exec, execFile } from "node:child_process";
import { mkdir, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  Agent,
  type AgentTool,
  type AgentEvent as PiAgentEvent,
} from "@earendil-works/pi-agent-core";
import { type Api, type Model, streamSimple, type TSchema, Type } from "@earendil-works/pi-ai";
import type { AgentEvent } from "./events";

export type RunDirectAgentInput = {
  apiKey: string;
  baseUrl?: string;
  model: string;
  prompt: string;
  cwd: string;
  abortController: AbortController;
  protocol?: string;
  conversationHistory?: Array<{ role: "user" | "assistant"; content: string }>;
  onEvent: (event: AgentEvent) => void;
};

const SYSTEM_PROMPT = [
  "You are a helpful assistant with access to the user's local workspace.",
  "Use tools when needed to inspect files, run commands, and answer questions.",
  "Be concise and direct. Respond in the same language as the user.",
].join(" ");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Check that `resolved` is equal to or inside `cwd`. Prevents prefix-collision escapes. */
function insideWorkspace(resolved: string, cwd: string): boolean {
  return resolved === cwd || resolved.startsWith(cwd + path.sep);
}

/**
 * Resolve a workspace-relative path for a *read* operation, following symlinks.
 * Returns the resolved path if safe, or throws if the real path escapes the workspace.
 */
async function resolveReadPath(cwd: string, filePath: string): Promise<string> {
  const resolved = path.resolve(cwd, filePath);
  if (!insideWorkspace(resolved, cwd)) throw new Error("path outside workspace");
  try {
    const real = await realpath(resolved);
    if (!insideWorkspace(real, cwd)) throw new Error("path outside workspace (symlink escape)");
  } catch (err) {
    // ENOENT is fine for read — the caller will get a normal "file not found" from readFile
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
  }
  return resolved;
}

/**
 * Resolve a workspace-relative path for a *write* operation, following symlinks
 * on the deepest existing ancestor. Mirrors the security model in workspace.ts
 * `resolveWritePathInsideWorkspace`.
 */
async function resolveWritePath(cwd: string, filePath: string): Promise<string> {
  const resolved = path.resolve(cwd, filePath);
  if (!insideWorkspace(resolved, cwd)) throw new Error("path outside workspace");

  // If the target already exists, realpath it directly
  try {
    const s = await stat(resolved);
    if (s) {
      const real = await realpath(resolved);
      if (!insideWorkspace(real, cwd)) throw new Error("path outside workspace (symlink escape)");
      return resolved;
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
  }

  // Walk up to the deepest existing ancestor and realpath it
  let ancestor = path.dirname(resolved);
  while (true) {
    try {
      const realAncestor = await realpath(ancestor);
      if (!insideWorkspace(realAncestor, cwd)) {
        throw new Error("path outside workspace (symlink escape)");
      }
      return resolved;
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
      const next = path.dirname(ancestor);
      if (next === ancestor) throw new Error("unable to resolve ancestor");
      ancestor = next;
    }
  }
}

// ---------------------------------------------------------------------------
// Tool execution
// ---------------------------------------------------------------------------

async function executeTool(
  name: string,
  input: Record<string, unknown>,
  cwd: string,
): Promise<string> {
  if (name === "bash") {
    const command = typeof input.command === "string" ? input.command : "";
    return new Promise((resolve) => {
      exec(command, { cwd, timeout: 30_000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
        const out = (stdout || "").trim();
        const errOut = (stderr || "").trim();
        if (err && !out && !errOut) {
          resolve(`Error: ${err.message}`);
        } else {
          resolve([out, errOut].filter(Boolean).join("\n") || "(no output)");
        }
      });
    });
  }

  if (name === "read_file") {
    const filePath = typeof input.path === "string" ? input.path : "";
    try {
      const resolved = await resolveReadPath(cwd, filePath);
      const content = await readFile(resolved, "utf-8");
      return content.length > 50_000 ? `${content.slice(0, 50_000)}\n...(truncated)` : content;
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : "read failed"}`;
    }
  }

  if (name === "list_dir") {
    const dirPath = typeof input.path === "string" ? input.path : ".";
    try {
      const resolved = await resolveReadPath(cwd, dirPath);
      const entries = await readdir(resolved, { withFileTypes: true });
      return entries
        .map((e) => `${e.isDirectory() ? "\u{1F4C1}" : "\u{1F4C4}"} ${e.name}`)
        .join("\n");
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : "list failed"}`;
    }
  }

  if (name === "write_file") {
    const filePath = typeof input.path === "string" ? input.path : "";
    const content = typeof input.content === "string" ? input.content : "";
    try {
      const resolved = await resolveWritePath(cwd, filePath);
      await mkdir(path.dirname(resolved), { recursive: true });
      await writeFile(resolved, content, "utf-8");
      return `File written: ${filePath}`;
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : "write failed"}`;
    }
  }

  if (name === "edit_file") {
    const filePath = typeof input.path === "string" ? input.path : "";
    const oldStr = typeof input.old_string === "string" ? input.old_string : "";
    const newStr = typeof input.new_string === "string" ? input.new_string : "";
    try {
      const resolved = await resolveWritePath(cwd, filePath);
      const content = await readFile(resolved, "utf-8");
      if (!content.includes(oldStr)) return "Error: old_string not found in file";
      const updated = content.replace(oldStr, newStr);
      await writeFile(resolved, updated, "utf-8");
      return `File edited: ${filePath}`;
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : "edit failed"}`;
    }
  }

  if (name === "grep") {
    const pattern = typeof input.pattern === "string" ? input.pattern : "";
    const searchPath = typeof input.path === "string" ? input.path : ".";
    const include = typeof input.include === "string" ? input.include : "";
    const resolved = path.resolve(cwd, searchPath);
    if (!insideWorkspace(resolved, cwd)) return "Error: path outside workspace";
    // Use execFile with explicit args array to avoid shell injection.
    // grep is invoked directly (no shell), so $() / backticks are harmless.
    const args = ["-rn"];
    if (include) args.push(`--include=${include}`);
    args.push("--", pattern, searchPath);
    return new Promise((resolve) => {
      execFile("grep", args, { cwd, timeout: 15_000, maxBuffer: 1024 * 1024 }, (_err, stdout) => {
        const out = (stdout || "").trim();
        if (!out) resolve("No matches found");
        else resolve(out.length > 10_000 ? `${out.slice(0, 10_000)}\n...(truncated)` : out);
      });
    });
  }

  if (name === "glob") {
    const pattern = typeof input.pattern === "string" ? input.pattern : "";
    const namePattern = pattern.includes("/") ? path.basename(pattern) : pattern;
    const dirPattern = pattern.includes("/") ? path.dirname(pattern) : ".";
    const resolvedDir = path.resolve(cwd, dirPattern);
    if (!insideWorkspace(resolvedDir, cwd)) return "Error: path outside workspace";
    // Use execFile with explicit args to avoid shell injection via crafted patterns.
    const args = [
      dirPattern,
      "-name",
      namePattern,
      "-not",
      "-path",
      "*/node_modules/*",
      "-not",
      "-path",
      "*/.git/*",
    ];
    return new Promise((resolve) => {
      execFile("find", args, { cwd, timeout: 15_000, maxBuffer: 1024 * 1024 }, (_err, stdout) => {
        const out = (stdout || "").trim();
        if (!out) {
          resolve("No matches found");
        } else {
          // Sort and limit results (replaces piped `| sort | head -200`)
          const lines = out.split("\n").sort();
          resolve(lines.slice(0, 200).join("\n"));
        }
      });
    });
  }

  if (name === "web_search") {
    const query = typeof input.query === "string" ? input.query : "";
    try {
      const url =
        "https://api.duckduckgo.com/?format=json&no_html=1&skip_disambig=1&q=" +
        encodeURIComponent(query);
      const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      const data = (await response.json()) as {
        AbstractText?: string;
        RelatedTopics?: Array<{ Text?: string; FirstURL?: string }>;
      };
      const parts: string[] = [];
      if (data.AbstractText) parts.push(data.AbstractText);
      for (const topic of (data.RelatedTopics || []).slice(0, 5)) {
        if (topic.Text) {
          parts.push(`- ${topic.Text}${topic.FirstURL ? ` (${topic.FirstURL})` : ""}`);
        }
      }
      return parts.length > 0 ? parts.join("\n") : "No results found. Try a different query.";
    } catch (err) {
      return `Search error: ${err instanceof Error ? err.message : "failed"}`;
    }
  }

  return `Unknown tool: ${name}`;
}

// ---------------------------------------------------------------------------
// AgentTool definitions (typebox schemas wrapping executeTool)
// ---------------------------------------------------------------------------

function makeAgentTool<T extends TSchema>(
  name: string,
  label: string,
  description: string,
  parameters: T,
  cwd: string,
): AgentTool<T> {
  return {
    name,
    label,
    description,
    parameters,
    execute: async (_toolCallId, params) => {
      const result = await executeTool(name, params as Record<string, unknown>, cwd);
      return { content: [{ type: "text", text: result }], details: undefined };
    },
  };
}

function buildTools(cwd: string): AgentTool<TSchema>[] {
  return [
    makeAgentTool(
      "bash",
      "Bash",
      "Run a shell command and return its output.",
      Type.Object({
        command: Type.String({ description: "The shell command to execute" }),
      }),
      cwd,
    ),
    makeAgentTool(
      "read_file",
      "Read File",
      "Read the contents of a file at the given path (relative to cwd).",
      Type.Object({
        path: Type.String({ description: "File path relative to workspace root" }),
      }),
      cwd,
    ),
    makeAgentTool(
      "list_dir",
      "List Directory",
      "List files and directories at the given path.",
      Type.Object({
        path: Type.String({
          description: "Directory path relative to workspace root, use '.' for root",
        }),
      }),
      cwd,
    ),
    makeAgentTool(
      "write_file",
      "Write File",
      "Create or overwrite a file with the given content.",
      Type.Object({
        path: Type.String({ description: "File path relative to workspace root" }),
        content: Type.String({ description: "The content to write" }),
      }),
      cwd,
    ),
    makeAgentTool(
      "edit_file",
      "Edit File",
      "Edit a file by replacing an exact string match. Use this for precise modifications.",
      Type.Object({
        path: Type.String({ description: "File path relative to workspace root" }),
        old_string: Type.String({ description: "The exact string to find and replace" }),
        new_string: Type.String({ description: "The replacement string" }),
      }),
      cwd,
    ),
    makeAgentTool(
      "grep",
      "Grep",
      "Search for a text pattern in files. Returns matching lines with file paths and line numbers.",
      Type.Object({
        pattern: Type.String({ description: "Search pattern (literal string or regex)" }),
        path: Type.Optional(
          Type.String({
            description:
              "Directory or file to search in, relative to workspace root. Defaults to '.'",
          }),
        ),
        include: Type.Optional(
          Type.String({ description: "File glob pattern to filter, e.g. '*.ts' or '*.py'" }),
        ),
      }),
      cwd,
    ),
    makeAgentTool(
      "glob",
      "Glob",
      "Find files matching a glob pattern. Returns a list of matching file paths.",
      Type.Object({
        pattern: Type.String({ description: "Glob pattern, e.g. '**/*.ts', 'src/**/*.json'" }),
      }),
      cwd,
    ),
    makeAgentTool(
      "web_search",
      "Web Search",
      "Search the web for information. Use this when you need current/real-time data.",
      Type.Object({
        query: Type.String({ description: "The search query" }),
      }),
      cwd,
    ),
  ];
}

// ---------------------------------------------------------------------------
// Model construction helpers
// ---------------------------------------------------------------------------

function buildModel(input: RunDirectAgentInput): Model<Api> {
  if (input.protocol === "anthropic") {
    const baseUrl = (input.baseUrl || "https://api.anthropic.com").replace(/\/$/, "");
    return {
      id: input.model,
      name: input.model,
      api: "anthropic-messages",
      provider: "anthropic",
      baseUrl,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200_000,
      maxTokens: 8192,
    };
  }

  // Default: OpenAI-compatible completions
  const baseUrl = (input.baseUrl || "https://api.openai.com/v1").replace(/\/$/, "");
  return {
    id: input.model,
    name: input.model,
    api: "openai-completions",
    provider: "openai",
    baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 16_384,
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function runDirectAgent(input: RunDirectAgentInput): Promise<void> {
  const model = buildModel(input);
  const tools = buildTools(input.cwd);
  const apiKey = input.apiKey;

  // Build the effective prompt, prepending conversation history if present
  // (same pattern as claude.ts since pi-agent-core doesn't accept pre-seeded
  // message history directly).
  let effectivePrompt = input.prompt;
  if (input.conversationHistory && input.conversationHistory.length > 0) {
    const historyBlock = input.conversationHistory
      .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
      .join("\n\n");
    effectivePrompt = `${historyBlock}\n\n---\n\nUser: ${input.prompt}`;
  }

  const agent = new Agent({
    initialState: {
      model,
      tools,
      systemPrompt: SYSTEM_PROMPT,
    },
    streamFn: streamSimple,
    getApiKey: () => apiKey,
    toolExecution: "sequential",
  });

  // Map pi-agent-core events to our AgentEvent format
  agent.subscribe((event: PiAgentEvent) => {
    switch (event.type) {
      case "message_update": {
        // Extract text deltas from the assistant message event stream
        const ame = event.assistantMessageEvent;
        if (ame.type === "text_delta") {
          input.onEvent({ type: "final_text", content: ame.delta });
        }
        break;
      }
      case "tool_execution_start":
        input.onEvent({
          type: "tool_start",
          toolName: event.toolName,
          toolInput: event.args,
        });
        break;
      case "tool_execution_end": {
        const resultContent = event.result?.content;
        let text = "";
        if (Array.isArray(resultContent)) {
          text = resultContent
            .filter((c: { type: string }) => c.type === "text")
            .map((c: { type: string; text?: string }) => c.text || "")
            .join("\n");
        }
        input.onEvent({
          type: "tool_result",
          content: text.length > 500 ? `${text.slice(0, 500)}...` : text,
        });
        break;
      }
      case "agent_end": {
        // Check if agent ended with an error
        const msgs = event.messages;
        if (msgs.length > 0) {
          const last = msgs[msgs.length - 1];
          if (
            last &&
            "role" in last &&
            last.role === "assistant" &&
            "errorMessage" in last &&
            last.errorMessage
          ) {
            input.onEvent({ type: "error", content: last.errorMessage });
          }
        }
        break;
      }
      default:
        break;
    }
  });

  // Wire up external abort to the agent
  const onAbort = () => agent.abort();
  if (input.abortController.signal.aborted) {
    agent.abort();
  } else {
    input.abortController.signal.addEventListener("abort", onAbort, { once: true });
  }

  try {
    await agent.prompt(effectivePrompt);
    await agent.waitForIdle();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    input.onEvent({ type: "error", content: msg });
  } finally {
    input.abortController.signal.removeEventListener("abort", onAbort);
    input.onEvent({ type: "done" });
  }
}
