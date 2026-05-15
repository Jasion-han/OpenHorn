import { exec } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
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

const TOOLS = [
  {
    name: "bash",
    description: "Run a shell command and return its output.",
    input_schema: {
      type: "object" as const,
      properties: {
        command: { type: "string" as const, description: "The shell command to execute" },
      },
      required: ["command"],
    },
  },
  {
    name: "read_file",
    description: "Read the contents of a file at the given path (relative to cwd).",
    input_schema: {
      type: "object" as const,
      properties: {
        path: { type: "string" as const, description: "File path relative to workspace root" },
      },
      required: ["path"],
    },
  },
  {
    name: "list_dir",
    description: "List files and directories at the given path.",
    input_schema: {
      type: "object" as const,
      properties: {
        path: {
          type: "string" as const,
          description: "Directory path relative to workspace root, use '.' for root",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "Create or overwrite a file with the given content.",
    input_schema: {
      type: "object" as const,
      properties: {
        path: { type: "string" as const, description: "File path relative to workspace root" },
        content: { type: "string" as const, description: "The content to write" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "edit_file",
    description:
      "Edit a file by replacing an exact string match. Use this for precise modifications.",
    input_schema: {
      type: "object" as const,
      properties: {
        path: { type: "string" as const, description: "File path relative to workspace root" },
        old_string: {
          type: "string" as const,
          description: "The exact string to find and replace",
        },
        new_string: { type: "string" as const, description: "The replacement string" },
      },
      required: ["path", "old_string", "new_string"],
    },
  },
  {
    name: "grep",
    description:
      "Search for a text pattern in files. Returns matching lines with file paths and line numbers.",
    input_schema: {
      type: "object" as const,
      properties: {
        pattern: {
          type: "string" as const,
          description: "Search pattern (literal string or regex)",
        },
        path: {
          type: "string" as const,
          description:
            "Directory or file to search in, relative to workspace root. Defaults to '.'",
        },
        include: {
          type: "string" as const,
          description: "File glob pattern to filter, e.g. '*.ts' or '*.py'",
        },
      },
      required: ["pattern"],
    },
  },
  {
    name: "glob",
    description: "Find files matching a glob pattern. Returns a list of matching file paths.",
    input_schema: {
      type: "object" as const,
      properties: {
        pattern: {
          type: "string" as const,
          description: "Glob pattern, e.g. '**/*.ts', 'src/**/*.json'",
        },
      },
      required: ["pattern"],
    },
  },
  {
    name: "web_search",
    description: "Search the web for information. Use this when you need current/real-time data.",
    input_schema: {
      type: "object" as const,
      properties: {
        query: { type: "string" as const, description: "The search query" },
      },
      required: ["query"],
    },
  },
];

const MAX_TURNS = 30;
const SYSTEM_PROMPT = [
  "You are a helpful assistant with access to the user's local workspace.",
  "Use tools when needed to inspect files, run commands, and answer questions.",
  "Be concise and direct. Respond in the same language as the user.",
].join(" ");

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
    const resolved = path.resolve(cwd, filePath);
    if (!resolved.startsWith(cwd)) return "Error: path outside workspace";
    try {
      const content = await readFile(resolved, "utf-8");
      return content.length > 50_000 ? `${content.slice(0, 50_000)}\n...(truncated)` : content;
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : "read failed"}`;
    }
  }

  if (name === "list_dir") {
    const dirPath = typeof input.path === "string" ? input.path : ".";
    const resolved = path.resolve(cwd, dirPath);
    if (!resolved.startsWith(cwd)) return "Error: path outside workspace";
    try {
      const entries = await readdir(resolved, { withFileTypes: true });
      return entries.map((e) => `${e.isDirectory() ? "📁" : "📄"} ${e.name}`).join("\n");
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : "list failed"}`;
    }
  }

  if (name === "write_file") {
    const filePath = typeof input.path === "string" ? input.path : "";
    const content = typeof input.content === "string" ? input.content : "";
    const resolved = path.resolve(cwd, filePath);
    if (!resolved.startsWith(cwd)) return "Error: path outside workspace";
    try {
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
    const resolved = path.resolve(cwd, filePath);
    if (!resolved.startsWith(cwd)) return "Error: path outside workspace";
    try {
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
    if (!resolved.startsWith(cwd)) return "Error: path outside workspace";
    const includeArg = include ? ` --include=${JSON.stringify(include)}` : "";
    return new Promise((resolve) => {
      exec(
        `grep -rn${includeArg} -- ${JSON.stringify(pattern)} ${JSON.stringify(searchPath)}`,
        { cwd, timeout: 15_000, maxBuffer: 1024 * 1024 },
        (_err, stdout) => {
          const out = (stdout || "").trim();
          if (!out) resolve("No matches found");
          else resolve(out.length > 10_000 ? `${out.slice(0, 10_000)}\n...(truncated)` : out);
        },
      );
    });
  }

  if (name === "glob") {
    const pattern = typeof input.pattern === "string" ? input.pattern : "";
    const namePattern = pattern.includes("/") ? path.basename(pattern) : pattern;
    const dirPattern = pattern.includes("/") ? path.dirname(pattern) : ".";
    return new Promise((resolve) => {
      exec(
        `find ${JSON.stringify(dirPattern)} -name ${JSON.stringify(namePattern)} -not -path "*/node_modules/*" -not -path "*/.git/*" | sort | head -200`,
        { cwd, timeout: 15_000, maxBuffer: 1024 * 1024 },
        (_err, stdout) => {
          const out = (stdout || "").trim();
          if (!out) resolve("No matches found");
          else resolve(out);
        },
      );
    });
  }

  if (name === "web_search") {
    const query = typeof input.query === "string" ? input.query : "";
    try {
      const url =
        "https://api.duckduckgo.com/?format=json&no_html=1&skip_disambig=1&q=" +
        encodeURIComponent(query);
      const response = await fetch(url);
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

type ApiMessage = {
  role: "user" | "assistant";
  content: string | Array<Record<string, unknown>>;
};

async function runAnthropicAgent(input: RunDirectAgentInput): Promise<void> {
  const baseUrl = (input.baseUrl || "https://api.anthropic.com").replace(/\/$/, "");
  const messages: ApiMessage[] = [];

  if (input.conversationHistory) {
    for (const msg of input.conversationHistory) {
      messages.push({ role: msg.role, content: msg.content });
    }
  }
  messages.push({ role: "user", content: input.prompt });

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    if (input.abortController.signal.aborted) break;

    const isOAuthToken = input.apiKey.startsWith("sk-ant-oat");
    const authHeaders: Record<string, string> = isOAuthToken
      ? { Authorization: `Bearer ${input.apiKey}` }
      : { "x-api-key": input.apiKey };
    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: input.model,
        max_tokens: 8192,
        system: SYSTEM_PROMPT,
        messages,
        tools: TOOLS,
      }),
      signal: input.abortController.signal,
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => "API error");
      input.onEvent({
        type: "error",
        content: `API error ${response.status}: ${errText.slice(0, 200)}`,
      });
      return;
    }

    const data = (await response.json()) as {
      content: Array<{
        type: string;
        text?: string;
        id?: string;
        name?: string;
        input?: Record<string, unknown>;
      }>;
      stop_reason: string;
    };

    messages.push({ role: "assistant", content: data.content as unknown as string });

    for (const block of data.content) {
      if (block.type === "text" && block.text) {
        input.onEvent({ type: "text", content: block.text });
      }
    }

    const toolBlocks = data.content.filter((b) => b.type === "tool_use");
    if (toolBlocks.length === 0 || data.stop_reason === "end_turn") break;

    const toolResults: Array<Record<string, unknown>> = [];
    for (const tool of toolBlocks) {
      const toolName = tool.name || "";
      const toolInput = (tool.input || {}) as Record<string, unknown>;
      input.onEvent({ type: "tool_start", toolName, toolInput });
      const result = await executeTool(toolName, toolInput, input.cwd);
      input.onEvent({
        type: "tool_result",
        content: result.length > 500 ? `${result.slice(0, 500)}...` : result,
      });
      toolResults.push({ type: "tool_result", tool_use_id: tool.id, content: result });
    }

    messages.push({ role: "user", content: toolResults as unknown as string });
  }
}

const OPENAI_TOOLS = TOOLS.map((t) => ({
  type: "function" as const,
  function: { name: t.name, description: t.description, parameters: t.input_schema },
}));

async function runOpenAIAgent(input: RunDirectAgentInput): Promise<void> {
  const baseUrl = (input.baseUrl || "https://api.openai.com/v1").replace(/\/$/, "");
  const messages: Array<Record<string, unknown>> = [{ role: "system", content: SYSTEM_PROMPT }];

  if (input.conversationHistory) {
    for (const msg of input.conversationHistory) {
      messages.push({ role: msg.role, content: msg.content });
    }
  }
  messages.push({ role: "user", content: input.prompt });

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    if (input.abortController.signal.aborted) break;

    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${input.apiKey}`,
      },
      body: JSON.stringify({
        model: input.model,
        messages,
        tools: OPENAI_TOOLS,
        tool_choice: "auto",
      }),
      signal: input.abortController.signal,
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => "API error");
      input.onEvent({
        type: "error",
        content: `API error ${response.status}: ${errText.slice(0, 200)}`,
      });
      return;
    }

    const data = (await response.json()) as {
      choices: Array<{
        message: {
          role: string;
          content?: string | null;
          tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
        };
        finish_reason: string;
      }>;
    };

    const choice = data.choices?.[0];
    if (!choice) break;

    const msg = choice.message;
    messages.push(msg as Record<string, unknown>);

    if (msg.content) {
      input.onEvent({ type: "text", content: msg.content });
    }

    const toolCalls = msg.tool_calls;
    if (!toolCalls || toolCalls.length === 0 || choice.finish_reason === "stop") break;

    for (const tc of toolCalls) {
      const toolName = tc.function.name;
      let toolInput: Record<string, unknown> = {};
      try {
        toolInput = JSON.parse(tc.function.arguments);
      } catch {}
      input.onEvent({ type: "tool_start", toolName, toolInput });
      const result = await executeTool(toolName, toolInput, input.cwd);
      input.onEvent({
        type: "tool_result",
        content: result.length > 500 ? `${result.slice(0, 500)}...` : result,
      });
      messages.push({ role: "tool", tool_call_id: tc.id, content: result });
    }
  }
}

export async function runDirectAgent(input: RunDirectAgentInput): Promise<void> {
  try {
    if (input.protocol === "anthropic") {
      await runAnthropicAgent(input);
    } else {
      await runOpenAIAgent(input);
    }
  } finally {
    input.onEvent({ type: "done" });
  }
}
