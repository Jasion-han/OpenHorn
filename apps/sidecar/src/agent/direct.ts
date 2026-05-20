import { exec, execFile } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  Agent,
  type AgentTool,
  type AgentEvent as PiAgentEvent,
} from "@earendil-works/pi-agent-core";
import { type Api, type Model, streamSimple, type TSchema, Type } from "@earendil-works/pi-ai";
import type { AgentEvent } from "./events";
import { buildIntentContext } from "./intent-context";

export type RunDirectAgentInput = {
  apiKey: string;
  baseUrl?: string;
  model: string;
  prompt: string;
  cwd: string;
  abortController: AbortController;
  conversationHistory?: Array<{ role: "user" | "assistant"; content: string }>;
  permissionMode?: "default" | "full-access";
  systemPrompt?: string;
  webSearchEnabled?: boolean;
  tavilyApiKey?: string;
  requestApproval?: (input: {
    toolName: string;
    toolInput: Record<string, unknown>;
    reason: string;
  }) => Promise<boolean>;
  onEvent: (event: AgentEvent) => void;
};

const SYSTEM_PROMPT = [
  "You are OpenHorn AI, a helpful assistant with access to the user's local files and system.",
  "You have tools for reading, writing, and editing files, searching code, running shell commands, and searching the web.",
  "Use tools proactively when the task requires inspecting files, running commands, or looking up information.",
  "",
  "Response style:",
  "- Answer directly.",
  "- Do not begin by repeating or paraphrasing the user's request.",
  "- Keep internal reasoning and tool-use details out of the final answer unless the user explicitly asks for them.",
  "- When the next step is clear, lead with the answer, result, or concrete action.",
  "",
  "Safety:",
  "- Before running destructive commands (rm, drop, kill, format), confirm with the user unless explicitly instructed.",
  "- Do not access or modify files outside the user's intended scope without asking.",
  "",
  "Always respond in the same language as the user.",
].join("\n");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum number of agent turns before forced stop (prevents infinite loops). */
const MAX_TURNS = 30;

/** Max characters returned from a single tool output for bash/read/grep etc. */
const MAX_READ_CHARS = 50_000;
const MAX_GREP_CHARS = 10_000;
const MAX_LIST_DIR_ENTRIES = 1_000;
const BASH_MAX_BUFFER = 1024 * 1024;
const BASH_TIMEOUT_MS = 30_000;
const SUBPROCESS_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// Tool execution
// ---------------------------------------------------------------------------

interface ExecuteToolOptions {
  permissionMode?: "default" | "full-access";
  tavilyApiKey?: string;
  requestApproval?: (input: {
    toolName: string;
    toolInput: Record<string, unknown>;
    reason: string;
  }) => Promise<boolean>;
}

async function executeTool(
  name: string,
  input: Record<string, unknown>,
  cwd: string,
  options?: ExecuteToolOptions,
): Promise<string> {
  if (name === "bash") {
    const command = typeof input.command === "string" ? input.command.trim() : "";
    if (!command) return "Error: command is empty";

    // Risk-based approval for bash commands in default permission mode
    if (options?.permissionMode !== "full-access") {
      const { classifyBashCommandRisk } = await import("../shell-risk");
      const risk = classifyBashCommandRisk(command);
      if (risk.level !== "allow" && options?.requestApproval) {
        const allowed = await options.requestApproval({
          toolName: "bash",
          toolInput: { command },
          reason: risk.reason || "This command may be dangerous",
        });
        if (!allowed) return "Command rejected by user";
      }
    }

    return new Promise((resolve) => {
      exec(
        command,
        { cwd, timeout: BASH_TIMEOUT_MS, maxBuffer: BASH_MAX_BUFFER },
        (err, stdout, stderr) => {
          const out = (stdout || "").trim();
          const errOut = (stderr || "").trim();
          if (err && !out && !errOut) {
            resolve(`Error: ${err.message}`);
          } else {
            resolve([out, errOut].filter(Boolean).join("\n") || "(no output)");
          }
        },
      );
    });
  }

  if (name === "read_file") {
    const filePath = typeof input.path === "string" ? input.path.trim() : "";
    if (!filePath) return "Error: path is required";
    try {
      const resolved = path.resolve(cwd, filePath);
      const content = await readFile(resolved, "utf-8");
      return content.length > MAX_READ_CHARS
        ? `${content.slice(0, MAX_READ_CHARS)}\n...(truncated)`
        : content;
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : "read failed"}`;
    }
  }

  if (name === "list_dir") {
    const dirPath = typeof input.path === "string" ? input.path.trim() || "." : ".";
    try {
      const resolved = path.resolve(cwd, dirPath);
      const entries = await readdir(resolved, { withFileTypes: true });
      const lines = entries
        .slice(0, MAX_LIST_DIR_ENTRIES)
        .map((e) => `${e.isDirectory() ? "\u{1F4C1}" : "\u{1F4C4}"} ${e.name}`);
      if (entries.length > MAX_LIST_DIR_ENTRIES) {
        lines.push(`...(${entries.length - MAX_LIST_DIR_ENTRIES} more entries omitted)`);
      }
      return lines.join("\n");
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : "list failed"}`;
    }
  }

  if (name === "write_file") {
    const filePath = typeof input.path === "string" ? input.path.trim() : "";
    if (!filePath) return "Error: path is required";
    const content = typeof input.content === "string" ? input.content : "";
    try {
      const resolved = path.resolve(cwd, filePath);
      await mkdir(path.dirname(resolved), { recursive: true });
      await writeFile(resolved, content, "utf-8");
      return `File written: ${filePath}`;
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : "write failed"}`;
    }
  }

  if (name === "edit_file") {
    const filePath = typeof input.path === "string" ? input.path.trim() : "";
    if (!filePath) return "Error: path is required";
    const oldStr = typeof input.old_string === "string" ? input.old_string : "";
    const newStr = typeof input.new_string === "string" ? input.new_string : "";
    if (!oldStr) return "Error: old_string must not be empty";
    try {
      const resolved = path.resolve(cwd, filePath);
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
    if (!pattern) return "Error: pattern is required";
    const searchPath = typeof input.path === "string" ? input.path : ".";
    const include = typeof input.include === "string" ? input.include : "";
    // Use execFile with explicit args array to avoid shell injection.
    // grep is invoked directly (no shell), so $() / backticks are harmless.
    const args = ["-rn"];
    if (include) args.push(`--include=${include}`);
    args.push("--", pattern, searchPath);
    return new Promise((resolve) => {
      execFile(
        "grep",
        args,
        { cwd, timeout: SUBPROCESS_TIMEOUT_MS, maxBuffer: BASH_MAX_BUFFER },
        (_err, stdout) => {
          const out = (stdout || "").trim();
          if (!out) resolve("No matches found");
          else
            resolve(
              out.length > MAX_GREP_CHARS ? `${out.slice(0, MAX_GREP_CHARS)}\n...(truncated)` : out,
            );
        },
      );
    });
  }

  if (name === "glob") {
    const pattern = typeof input.pattern === "string" ? input.pattern : "";
    if (!pattern) return "Error: pattern is required";
    const namePattern = pattern.includes("/") ? path.basename(pattern) : pattern;
    // Strip "**" segments from dir -- `find` already recurses; "**" is shell glob
    // syntax that find would treat as a literal directory name.
    const rawDir = pattern.includes("/") ? path.dirname(pattern) : ".";
    const dirPattern =
      rawDir
        .split("/")
        .filter((seg) => seg !== "**")
        .join("/") || ".";
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
      execFile(
        "find",
        args,
        { cwd, timeout: SUBPROCESS_TIMEOUT_MS, maxBuffer: BASH_MAX_BUFFER },
        (_err, stdout) => {
          const out = (stdout || "").trim();
          if (!out) {
            resolve("No matches found");
          } else {
            // Sort and limit results (replaces piped `| sort | head -200`)
            const lines = out.split("\n").sort();
            resolve(lines.slice(0, 200).join("\n"));
          }
        },
      );
    });
  }

  if (name === "web_search") {
    const query = typeof input.query === "string" ? input.query.trim() : "";
    if (!query) return "Error: query is required";

    const tavilyKey = options?.tavilyApiKey;
    if (!tavilyKey) {
      return "Error: web search is not configured. Please set a Tavily API Key in Agent settings.";
    }

    try {
      const resp = await fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_key: tavilyKey,
          query,
          max_results: 5,
          include_answer: true,
        }),
        signal: AbortSignal.timeout(SUBPROCESS_TIMEOUT_MS),
      });
      const data = (await resp.json()) as {
        answer?: string;
        results?: Array<{ title?: string; url?: string; content?: string }>;
      };
      const parts: string[] = [];
      if (data.answer) parts.push(data.answer);
      for (const r of (data.results || []).slice(0, 5)) {
        parts.push(`### ${r.title || "Untitled"}\n${r.url || ""}\n${r.content || ""}`);
      }
      return parts.length > 0 ? parts.join("\n\n") : "No results found.";
    } catch (err) {
      return `Search error: ${err instanceof Error ? err.message : "failed"}`;
    }
  }

  if (name === "web_fetch") {
    const url = typeof input.url === "string" ? input.url.trim() : "";
    if (!url) return "Error: url is required";

    try {
      const resp = await fetch(url, {
        headers: { "User-Agent": "OpenHorn/1.0 (compatible; bot)" },
        signal: AbortSignal.timeout(SUBPROCESS_TIMEOUT_MS),
        redirect: "follow",
      });
      if (!resp.ok) return `Error: HTTP ${resp.status} ${resp.statusText}`;
      const contentType = resp.headers.get("content-type") || "";
      if (
        !contentType.includes("text/html") &&
        !contentType.includes("text/plain") &&
        !contentType.includes("application/json")
      ) {
        return `Error: unsupported content type: ${contentType}`;
      }
      const html = await resp.text();
      if (contentType.includes("text/plain") || contentType.includes("application/json")) {
        return html.length > MAX_READ_CHARS
          ? `${html.slice(0, MAX_READ_CHARS)}\n...(truncated)`
          : html;
      }
      // HTML -> Markdown via turndown
      const TurndownService = (await import("turndown")).default;
      const td = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
      td.remove(["script", "style", "nav", "footer", "header", "aside", "iframe", "noscript"]);
      const md = td.turndown(html);
      return md.length > MAX_READ_CHARS
        ? `${md.slice(0, MAX_READ_CHARS)}\n...(truncated)`
        : md;
    } catch (err) {
      return `Fetch error: ${err instanceof Error ? err.message : "failed"}`;
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
  options?: ExecuteToolOptions,
): AgentTool<T> {
  return {
    name,
    label,
    description,
    parameters,
    execute: async (_toolCallId, params) => {
      const result = await executeTool(name, params as Record<string, unknown>, cwd, options);
      return { content: [{ type: "text", text: result }], details: undefined };
    },
  };
}

interface BuildToolsOptions extends ExecuteToolOptions {
  webSearchEnabled?: boolean;
}

function buildTools(cwd: string, options?: BuildToolsOptions): AgentTool<TSchema>[] {
  const tools: AgentTool<TSchema>[] = [
    makeAgentTool(
      "bash",
      "Bash",
      "Run a shell command and return its output.",
      Type.Object({
        command: Type.String({ description: "The shell command to execute" }),
      }),
      cwd,
      options,
    ),
    makeAgentTool(
      "read_file",
      "Read File",
      "Read the contents of a file at the given path (relative to cwd).",
      Type.Object({
        path: Type.String({ description: "File path relative to workspace root" }),
      }),
      cwd,
      options,
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
      options,
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
      options,
    ),
    makeAgentTool(
      "edit_file",
      "Edit File",
      "Edit a file by replacing the first occurrence of an exact string match. Use this for precise modifications. If the string appears multiple times, only the first match is replaced.",
      Type.Object({
        path: Type.String({ description: "File path relative to workspace root" }),
        old_string: Type.String({ description: "The exact string to find and replace" }),
        new_string: Type.String({ description: "The replacement string" }),
      }),
      cwd,
      options,
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
      options,
    ),
    makeAgentTool(
      "glob",
      "Glob",
      "Find files matching a glob pattern. Returns a list of matching file paths.",
      Type.Object({
        pattern: Type.String({ description: "Glob pattern, e.g. '**/*.ts', 'src/**/*.json'" }),
      }),
      cwd,
      options,
    ),
  ];

  // Only include web tools when webSearchEnabled is not explicitly false
  if (options?.webSearchEnabled !== false) {
    tools.push(
      makeAgentTool(
        "web_search",
        "Web Search",
        "Search the web for information. Use this when you need current/real-time data.",
        Type.Object({
          query: Type.String({ description: "The search query" }),
        }),
        cwd,
        options,
      ),
      makeAgentTool(
        "web_fetch",
        "Web Fetch",
        "Fetch a web page and return its content as Markdown. Use this to read documentation, articles, or any web content.",
        Type.Object({
          url: Type.String({ description: "The URL to fetch" }),
        }),
        cwd,
        options,
      ),
    );
  }

  return tools;
}

// ---------------------------------------------------------------------------
// Model construction helpers
// ---------------------------------------------------------------------------

function isChatGptOAuthToken(key: string): boolean {
  if (!key.startsWith("eyJ")) return false;
  try {
    const payload = key.split(".")[1];
    if (!payload) return false;
    const padded = payload + "=".repeat((4 - (payload.length % 4)) % 4);
    const json = JSON.parse(atob(padded.replace(/-/g, "+").replace(/_/g, "/")));
    const scopes: string[] = json.scp || [];
    return scopes.includes("api.connectors.invoke") && !scopes.includes("api.responses.write");
  } catch {
    return false;
  }
}

function buildModel(input: RunDirectAgentInput): Model<Api> {
  const useCodexResponses = isChatGptOAuthToken(input.apiKey);
  if (useCodexResponses) {
    return {
      id: input.model,
      name: input.model,
      api: "openai-codex-responses",
      provider: "openai-codex",
      baseUrl: "https://api.openai.com/v1",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 16_384,
    };
  }
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
  const tools = buildTools(input.cwd, {
    permissionMode: input.permissionMode,
    tavilyApiKey: input.tavilyApiKey,
    requestApproval: input.requestApproval,
    webSearchEnabled: input.webSearchEnabled,
  });
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

  // Merge product system prompt, user system prompt, and intent context
  const intentResult = await buildIntentContext(input.prompt, {
    webSearchEnabled: input.webSearchEnabled,
  });
  const finalSystemPrompt = [SYSTEM_PROMPT, input.systemPrompt, intentResult.context]
    .filter(Boolean)
    .join("\n\n");

  let turnCount = 0;
  const agent = new Agent({
    initialState: {
      model,
      tools,
      systemPrompt: finalSystemPrompt,
    },
    streamFn: streamSimple,
    getApiKey: () => apiKey,
    toolExecution: "sequential",
  });

  // Map pi-agent-core events to our AgentEvent format
  agent.subscribe((event: PiAgentEvent) => {
    switch (event.type) {
      case "turn_end":
        turnCount++;
        if (turnCount >= MAX_TURNS) {
          input.onEvent({
            type: "error",
            content: `Agent stopped: reached maximum of ${MAX_TURNS} turns`,
          });
          agent.abort();
        }
        break;
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
