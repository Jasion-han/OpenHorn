import { execFile } from "node:child_process";
import { mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  Agent,
  type AgentTool,
  type AgentEvent as PiAgentEvent,
} from "@earendil-works/pi-agent-core";
import {
  type Api,
  type ImageContent,
  type Message,
  type Model,
  streamSimple,
  type TSchema,
  Type,
} from "@earendil-works/pi-ai";
import { resolveContextPolicy } from "shared/context-policy";
import {
  assertPublicWebUrl,
  buildTavilyPayload,
  fetchDeepSeek,
  formatUntrustedWebSources,
  isNewsQuery,
  normalizeCitations,
  normalizeSearchQuery,
  type PreferredSearchProvider,
  type ResolveWebHostname,
  readBoundedWebResponse,
  rerankCitations,
  type SearchCitation,
  searchDeepSeek,
  searchDuckDuckGo,
  selectSearchProvider,
  type TavilyResult,
} from "shared/search";
import type { AttachmentPart, ModelContextMetadata } from "shared/types";

export type { PreferredSearchProvider } from "shared/search";
export { isBlockedIpAddress } from "shared/search";

import { modelSupportsVision } from "shared/vision";
import {
  createCheckpointSession,
  ensureCheckpointBackup,
  finalizeCheckpoint,
} from "../checkpoints";
import {
  resolvePathInsideWorkspace,
  resolveWritePathInsideWorkspace,
  toWorkspaceRelative,
  writeFileNoFollow,
} from "../workspace";
import {
  buildFileContext,
  getImageAttachments,
  imageFallbackText,
  imageUnsupportedFormatText,
  partitionImagesByFormat,
} from "./attachments";
import { sanitizeChildEnv } from "./childEnv";
import { buildHistoryMessages, type HistoryMessage } from "./context";
import { assertAgentContext, boundAgentHistory } from "./contextPolicy";
import { type AgentEvent, buildUsageEvent, toCount } from "./events";
import { buildIntentContext } from "./intent-context";
import { capMcpTools, connectMcpTools } from "./mcp-tools";
import { runShellCommand } from "./shell";
import { buildSkillsPromptSection, type MaterializedSkill } from "./skills";
import { buildAgentSystemPrompt, buildReActBehaviorSection } from "./system-prompt";

export type RunDirectAgentInput = {
  apiKey: string;
  baseUrl?: string;
  /**
   * Channel protocol. Decides which wire API the model speaks. Absent or
   * "openai" means OpenAI-compatible completions; "google" switches to
   * Gemini's generative-language API. Without this, google channels were
   * silently driven as openai-completions and every request failed.
   */
  protocol?: string;
  model: string;
  contextWindow?: number | null;
  contextMetadata?: ModelContextMetadata | null;
  prompt: string;
  cwd: string;
  abortController: AbortController;
  conversationHistory?: Array<{ role: "user" | "assistant"; content: string }>;
  permissionMode?: "default" | "full-access";
  systemPrompt?: string;
  webSearchEnabled?: boolean;
  tavilyApiKey?: string;
  deepseekApiKey?: string;
  searchProvider?: PreferredSearchProvider;
  /** Enabled MCP servers keyed by name (`{ type, command/url, args, env }`). */
  mcpServers?: Record<string, Record<string, unknown>>;
  attachments?: AttachmentPart[];
  checkpoint?: import("../checkpoints").CheckpointSession;
  /** Enabled skills materialized to the workspace; read on demand via `read_file`. */
  skills?: MaterializedSkill[];
  /** Per-run token budget. When cumulative tokens exceed this limit the agent is aborted. */
  tokenBudgetPerRun?: number;
  requestApproval?: (input: {
    toolName: string;
    toolInput: Record<string, unknown>;
    reason: string;
  }) => Promise<boolean>;
  onEvent: (event: AgentEvent) => void;
  onCheckpointReady?: () => void;
};

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
// SSRF guard (web_fetch)
// ---------------------------------------------------------------------------

/** Max redirect hops re-validated for web_fetch before giving up. */
const WEB_FETCH_MAX_HOPS = 5;

// ---------------------------------------------------------------------------
// Tool execution
// ---------------------------------------------------------------------------

export interface ExecuteToolOptions {
  signal?: AbortSignal;
  permissionMode?: "default" | "full-access";
  tavilyApiKey?: string;
  deepseekApiKey?: string;
  searchProvider?: PreferredSearchProvider;
  webSearchEnabled?: boolean;
  fetchImpl?: WebSearchFetchFn;
  resolveHostname?: ResolveWebHostname;
  timeoutMs?: number;
  /**
   * Extra roots that READ tools may reach outside the workspace — the enabled
   * skills' real folders. The system prompt tells the model to read each
   * skill's SKILL.md by absolute path; without this list every such read was
   * rejected as an escape, making Agent Skills unusable on this runtime.
   * Write/edit stay strictly workspace-bounded. Mirrors claude.ts.
   */
  readAllowRoots?: string[];
  checkpoint?: import("../checkpoints").CheckpointSession;
  requestApproval?: (input: {
    toolName: string;
    toolInput: Record<string, unknown>;
    reason: string;
  }) => Promise<boolean>;
}

/**
 * Resolves a model-supplied path for a *read* operation, keeping it inside the
 * workspace (`cwd` is the canonicalized workspace root — see index.ts). Models
 * frequently emit absolute paths that happen to live inside the workspace, so we
 * normalise via `toWorkspaceRelative` first, then apply the lexical boundary
 * check. Throws on `..`/absolute/escape; callers turn the throw into a tool-error
 * string rather than crashing the agent. Mirrors claude.ts `checkSdkFsToolPath`.
 */
function resolveReadPathInWorkspace(
  cwd: string,
  filePath: string,
  readAllowRoots: string[] = [],
): string {
  // Skills live outside the workspace and are read in place by absolute path.
  // Check them first, exactly as claude.ts does for its Read tool.
  if (readAllowRoots.length > 0) {
    const abs = path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(cwd, filePath);
    for (const root of readAllowRoots) {
      const r = path.resolve(root);
      if (abs === r || abs.startsWith(`${r}${path.sep}`)) return abs;
    }
  }
  const relative = toWorkspaceRelative(cwd, filePath);
  return resolvePathInsideWorkspace({ workspaceRoot: cwd, targetPath: relative });
}

/**
 * Resolves a model-supplied path for a *write* operation. Adds the
 * realpath-of-ancestor check so a symlink planted inside the workspace can't be
 * used to escape on first write.
 */
function resolveWritePathInWorkspace(cwd: string, filePath: string): Promise<string> {
  const relative = toWorkspaceRelative(cwd, filePath);
  return resolveWritePathInsideWorkspace({ workspaceRoot: cwd, targetPath: relative });
}

export async function executeTool(
  name: string,
  input: Record<string, unknown>,
  cwd: string,
  options?: ExecuteToolOptions,
): Promise<string> {
  if (options?.signal?.aborted) return "Command cancelled";
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
    if (options?.signal?.aborted) return "Command cancelled";

    return runShellCommand(command, cwd, {
      signal: options?.signal,
      timeoutMs: BASH_TIMEOUT_MS,
      maxBuffer: BASH_MAX_BUFFER,
    });
  }

  if (name === "read_file") {
    const filePath = typeof input.path === "string" ? input.path.trim() : "";
    if (!filePath) return "Error: path is required";
    try {
      const resolved = resolveReadPathInWorkspace(cwd, filePath, options?.readAllowRoots);
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
      const resolved = resolveReadPathInWorkspace(cwd, dirPath);
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
      if (options?.checkpoint) {
        await ensureCheckpointBackup(options.checkpoint, filePath).catch(() => {});
      }
      const resolved = await resolveWritePathInWorkspace(cwd, filePath);
      await mkdir(path.dirname(resolved), { recursive: true });
      if (options?.signal?.aborted) return "Command cancelled";
      await writeFileNoFollow(resolved, content);
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
      if (options?.checkpoint) {
        await ensureCheckpointBackup(options.checkpoint, filePath).catch(() => {});
      }
      const resolved = await resolveWritePathInWorkspace(cwd, filePath);
      const content = await readFile(resolved, "utf-8");
      if (!content.includes(oldStr)) return "Error: old_string not found in file";
      const updated = content.replace(oldStr, newStr);
      if (options?.signal?.aborted) return "Command cancelled";
      await writeFileNoFollow(resolved, updated);
      return `File edited: ${filePath}`;
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : "edit failed"}`;
    }
  }

  if (name === "grep") {
    const pattern = typeof input.pattern === "string" ? input.pattern : "";
    if (!pattern) return "Error: pattern is required";
    const searchPath = (typeof input.path === "string" && input.path) || ".";
    const include = typeof input.include === "string" ? input.include : "";
    // Keep the search path inside the workspace before handing it to a
    // subprocess (execFile gets no boundary check on its own — an absolute or
    // `..` path would escape). Turn an escape into a tool-error like the fs tools.
    let resolvedSearchPath: string;
    try {
      resolvedSearchPath = resolveReadPathInWorkspace(cwd, searchPath);
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : "invalid path"}`;
    }
    // Use execFile with explicit args array to avoid shell injection.
    // grep is invoked directly (no shell), so $() / backticks are harmless.
    const args = ["-rn"];
    if (include) args.push(`--include=${include}`);
    args.push("--", pattern, resolvedSearchPath);
    return new Promise((resolve) => {
      execFile(
        "grep",
        args,
        {
          cwd,
          timeout: SUBPROCESS_TIMEOUT_MS,
          maxBuffer: BASH_MAX_BUFFER,
          signal: options?.signal,
          env: sanitizeChildEnv(process.env),
        },
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
    // Only the base directory must be workspace-bounded; the glob wildcard
    // (namePattern) is unaffected. Reject an absolute/`..` base before spawning.
    let resolvedDir: string;
    try {
      resolvedDir = resolveReadPathInWorkspace(cwd, dirPattern);
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : "invalid path"}`;
    }
    // Use execFile with explicit args to avoid shell injection via crafted patterns.
    const args = [
      resolvedDir,
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
        {
          cwd,
          timeout: SUBPROCESS_TIMEOUT_MS,
          maxBuffer: BASH_MAX_BUFFER,
          signal: options?.signal,
          env: sanitizeChildEnv(process.env),
        },
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
    const query = typeof input.query === "string" ? input.query : "";
    if (options?.webSearchEnabled !== true) return "Error: web access is disabled";
    return runWebSearch(query, options);
  }

  if (name === "web_fetch") {
    if (options?.webSearchEnabled !== true) return "Error: web access is disabled";
    const url = typeof input.url === "string" ? input.url.trim() : "";
    if (!url) return "Error: url is required";

    if (options.searchProvider === "deepseek" && !options.deepseekApiKey?.trim()) {
      return "Fetch error: not_configured. Page content was not read.";
    }
    if (options.deepseekApiKey?.trim()) {
      try {
        const page = await fetchDeepSeek(url, {
          apiKey: options.deepseekApiKey,
          fetchImpl: options.fetchImpl,
          resolveHostname: options.resolveHostname,
          signal: options.signal,
          timeoutMs: options.timeoutMs,
        });
        return formatUntrustedWebSources([page]);
      } catch (error) {
        return `Fetch error: ${error instanceof Error ? error.message : "failed"}. Page content was not read.`;
      }
    }
    try {
      const signal = options.signal
        ? AbortSignal.any([
            options.signal,
            AbortSignal.timeout(options.timeoutMs ?? SUBPROCESS_TIMEOUT_MS),
          ])
        : AbortSignal.timeout(options.timeoutMs ?? SUBPROCESS_TIMEOUT_MS);
      // Follow redirects manually so each hop is re-validated against the SSRF
      // guard — a public URL that 30x-redirects to 169.254.169.254 or localhost
      // must not slip through.
      let currentUrl = url;
      let resp: Response | undefined;
      for (let hop = 0; hop < WEB_FETCH_MAX_HOPS; hop++) {
        signal.throwIfAborted();
        await assertPublicWebUrl(currentUrl, options.resolveHostname);
        signal.throwIfAborted();
        resp = await (options.fetchImpl ?? fetch)(currentUrl, {
          headers: { "User-Agent": "OpenHorn/1.0 (compatible; bot)" },
          signal,
          redirect: "manual",
        });
        if (resp.status < 300 || resp.status >= 400) break;
        const location = resp.headers.get("location");
        if (!location) break;
        void resp.body?.cancel().catch(() => {});
        currentUrl = new URL(location, currentUrl).toString();
        resp = undefined;
      }
      if (!resp) return "Error: too many redirects";
      if (!resp.ok) return `Error: HTTP ${resp.status} ${resp.statusText}`;
      const contentType = resp.headers.get("content-type") || "";
      if (
        !contentType.includes("text/html") &&
        !contentType.includes("text/plain") &&
        !contentType.includes("application/json")
      ) {
        return `Error: unsupported content type: ${contentType}`;
      }
      const html = await readBoundedWebResponse(resp, undefined, signal);
      const formatPage = (content: string) =>
        formatUntrustedWebSources([
          {
            title: currentUrl,
            url: currentUrl,
            content: content.slice(0, MAX_READ_CHARS),
          },
        ]);
      if (contentType.includes("text/plain") || contentType.includes("application/json")) {
        return formatPage(html);
      }
      // HTML -> Markdown via turndown
      const TurndownService = (await import("turndown")).default;
      const td = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
      td.remove(["script", "style", "nav", "footer", "header", "aside", "iframe", "noscript"]);
      const md = td.turndown(html);
      return formatPage(md);
    } catch (err) {
      return `Fetch error: ${err instanceof Error ? err.message : "failed"}`;
    }
  }

  return `Unknown tool: ${name}`;
}

// ---------------------------------------------------------------------------
// Web search (provider-agnostic core shared with the server)
// ---------------------------------------------------------------------------

type WebSearchFetchFn = (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
) => ReturnType<typeof fetch>;

export interface WebSearchOptions {
  /** Dedicated provider keys; auto keeps the legacy Tavily → DuckDuckGo order. */
  tavilyApiKey?: string;
  deepseekApiKey?: string;
  searchProvider?: PreferredSearchProvider;
  signal?: AbortSignal;
  /** Injectable fetch for tests; defaults to global fetch. */
  fetchImpl?: WebSearchFetchFn;
  /** Clock override for deterministic re-ranking in tests. */
  now?: () => number;
  /** Sleep hook (ms) — overridable in tests to avoid real DDG backoff delays. */
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
}

/** Format normalized citations into the sidecar's plain-text tool output. */
function formatSearchResults(citations: SearchCitation[], answer?: string): string {
  if (!citations.length) return "No results found.";
  return [
    formatUntrustedWebSources(citations),
    answer?.trim() ? `Untrusted provider summary (JSON): ${JSON.stringify(answer.trim())}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Tavily branch. Returns the formatted string on success, or null on any
 * failure (non-2xx / timeout / no results) so the caller can degrade to DDG.
 */
async function tavilyWebSearch(
  query: string,
  apiKey: string,
  options: WebSearchOptions,
): Promise<string | null> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const payload = buildTavilyPayload(query, { route: "web_search", includeAnswer: true });
  try {
    const resp = await fetchImpl("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // Sidecar keeps Tavily's legacy body-based auth (`api_key`).
      body: JSON.stringify({ api_key: apiKey, ...payload }),
      signal: AbortSignal.timeout(options.timeoutMs ?? SUBPROCESS_TIMEOUT_MS),
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as { answer?: string; results?: TavilyResult[] };
    const citations = rerankCitations(
      normalizeCitations(data.results),
      isNewsQuery(query),
      options.now,
    );
    if (citations.length === 0) return null;
    return formatSearchResults(citations, data.answer);
  } catch {
    return null;
  }
}

/** DuckDuckGo branch (keyless default / Tavily fallback). */
async function duckDuckGoWebSearch(query: string, options: WebSearchOptions): Promise<string> {
  const rawCitations = await searchDuckDuckGo(normalizeSearchQuery(query), {
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
    now: options.now,
    sleep: options.sleep,
  });
  if (rawCitations.length === 0) return "No results found.";
  const citations = rerankCitations(rawCitations, isNewsQuery(query), options.now);
  return formatSearchResults(citations);
}

/**
 * Explicit DeepSeek requires its dedicated key and returns honest failure.
 * Auto preserves legacy Tavily → DuckDuckGo; DeepSeek is never selected implicitly.
 */
export async function runWebSearch(query: string, options: WebSearchOptions = {}): Promise<string> {
  const trimmed = query.trim();
  if (!trimmed) return "Error: query is required";

  if (options.signal?.aborted) return "Error: web search aborted";
  const selected = selectSearchProvider(options);
  if (selected.provider === "none")
    return `Error: ${selected.reason}. Web search was not performed.`;
  if (selected.provider === "deepseek") {
    try {
      const citations = await searchDeepSeek(normalizeSearchQuery(trimmed), {
        apiKey: selected.apiKey,
        fetchImpl: options.fetchImpl,
        signal: options.signal,
        timeoutMs: options.timeoutMs,
      });
      return formatSearchResults(rerankCitations(citations, isNewsQuery(trimmed), options.now));
    } catch (error) {
      return `Search error: ${error instanceof Error ? error.message : "failed"}. No usable sources; do not claim you searched the web.`;
    }
  }
  if (selected.provider === "tavily") {
    const result = await tavilyWebSearch(trimmed, selected.apiKey, options);
    if (result !== null) return result;
    if (options.signal?.aborted) return "Error: web search aborted";
  }
  return duckDuckGoWebSearch(trimmed, options);
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
    execute: async (_toolCallId, params, signal) => {
      const result = await executeTool(name, params as Record<string, unknown>, cwd, {
        ...options,
        signal,
      });
      return { content: [{ type: "text", text: result }], details: undefined };
    },
  };
}

interface BuildToolsOptions extends ExecuteToolOptions {
  webSearchEnabled?: boolean;
}

export function buildTools(cwd: string, options?: BuildToolsOptions): AgentTool<TSchema>[] {
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

  // Web tools require explicit per-run network consent.
  if (options?.webSearchEnabled === true) {
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

/** Exported for tests: picks the wire API from the channel protocol. */
export function buildModel(input: RunDirectAgentInput, supportsVision: boolean): Model<Api> {
  // Only advertise image input when the model is vision-capable; otherwise the
  // provider may reject the request or mis-handle the image modality.
  const policy = resolveContextPolicy({ ...input, mode: "agent" });
  const modelInput: ("text" | "image")[] = supportsVision ? ["text", "image"] : ["text"];
  const useCodexResponses = isChatGptOAuthToken(input.apiKey);
  if (useCodexResponses) {
    return {
      id: input.model,
      name: input.model,
      api: "openai-codex-responses",
      provider: "openai-codex",
      baseUrl: "https://api.openai.com/v1",
      reasoning: false,
      input: modelInput,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: policy.contextWindow,
      maxTokens: policy.maxOutputTokens,
    };
  }
  if (input.protocol === "google") {
    return {
      id: input.model,
      name: input.model,
      api: "google-generative-ai",
      provider: "google",
      baseUrl: (input.baseUrl || "https://generativelanguage.googleapis.com/v1beta").replace(
        /\/$/,
        "",
      ),
      reasoning: false,
      input: modelInput,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: policy.contextWindow,
      maxTokens: policy.maxOutputTokens,
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
    input: modelInput,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: policy.contextWindow,
    maxTokens: policy.maxOutputTokens,
  };
}

/**
 * Converts normalized history into pi transcript messages for
 * `initialState.messages`. Assistant turns are synthesized as completed
 * (`stopReason: "stop"`) text replies attributed to the current model, so pi's
 * message transform replays them as plain assistant text; usage is zeroed
 * because these turns were already billed. Exported for tests.
 */
export function toPiHistoryMessages(history: HistoryMessage[], model: Model<Api>): Message[] {
  return history.map((m, i): Message => {
    const timestamp = Date.now() - (history.length - i);
    if (m.role === "user") return { role: "user", content: m.content, timestamp };
    return {
      role: "assistant",
      content: [{ type: "text", text: m.content }],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp,
    };
  });
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function runDirectAgent(input: RunDirectAgentInput): Promise<void> {
  if (input.abortController.signal.aborted) {
    input.onEvent({ type: "done" });
    return;
  }
  const images = getImageAttachments(input.attachments);
  const supportsVision = modelSupportsVision(input.model);
  const { injectable, unsupported } = supportsVision
    ? partitionImagesByFormat(images)
    : { injectable: [], unsupported: [] };
  const useVisionImages = injectable.length > 0;
  const model = buildModel(input, useVisionImages);
  const checkpoint = input.checkpoint ?? (await createCheckpointSession(input.cwd));
  let tools = buildTools(input.cwd, {
    permissionMode: input.permissionMode,
    tavilyApiKey: input.tavilyApiKey,
    deepseekApiKey: input.deepseekApiKey,
    searchProvider: input.searchProvider,
    requestApproval: input.requestApproval,
    webSearchEnabled: input.webSearchEnabled,
    checkpoint,
    readAllowRoots: (input.skills ?? []).map((skill) => skill.skillDir),
  });

  // Bridge enabled MCP servers into the tool set (best-effort). The Claude SDK
  // path gets MCP natively; here we connect and expose them as agent tools so
  // OpenAI-protocol models get the same capability. capMcpTools keeps the
  // combined tool count under the provider limit (server order wins ties), so
  // an oversized MCP roster degrades loudly instead of failing the request.
  let mcpCleanup: (() => Promise<void>) | null = null;
  if (input.mcpServers && Object.keys(input.mcpServers).length > 0) {
    const connected = await connectMcpTools(input.mcpServers);
    const mcpTools = capMcpTools(tools.length, connected.toolsByServer);
    if (mcpTools.length > 0) tools = [...tools, ...mcpTools];
    mcpCleanup = connected.cleanup;
  }
  const apiKey = input.apiKey;

  // History is seeded into the agent transcript as real user/assistant
  // messages (see `toPiHistoryMessages`); the current prompt plus attachments
  // stays the final user message sent via `agent.prompt`.
  let effectivePrompt = input.prompt;
  // Inject file attachment text (works for every model regardless of vision).
  const fileContext = buildFileContext(input.attachments);
  if (fileContext) effectivePrompt += fileContext;
  // Non-vision models can't receive images: degrade to a textual placeholder.
  // Vision models still degrade images whose format the provider rejects.
  if (!supportsVision && images.length > 0) {
    effectivePrompt += imageFallbackText(images);
  }
  if (unsupported.length > 0) {
    effectivePrompt += imageUnsupportedFormatText(unsupported);
  }

  // Merge product system prompt, user system prompt, and intent context
  const intentResult = await buildIntentContext(input.prompt, {
    webSearchEnabled: input.webSearchEnabled,
  });
  const finalSystemPrompt = [
    buildAgentSystemPrompt({
      cwd: input.cwd,
      permissionMode: input.permissionMode,
      // Same condition `buildTools` uses to register `web_fetch`.
      webFetchAvailable: input.webSearchEnabled === true,
      extra: buildSkillsPromptSection(input.skills ?? [], "read_file"),
    }),
    buildReActBehaviorSection(),
    // Direct-runtime-specific: GPT models tend to fire all available tools in
    // one massive batch. This extra nudge keeps them iterative.
    "After each tool call round, analyze the results before deciding the next action. Do not request all tools at once — execute in small batches so you can inspect intermediate results and adjust your approach.",
    input.systemPrompt,
    intentResult.context,
  ]
    .filter(Boolean)
    .join("\n\n");

  const toolDefinitions = tools.map(({ name, description, parameters }) => ({
    name,
    description,
    parameters,
  }));
  let history: ReturnType<typeof buildHistoryMessages>;
  try {
    history = buildHistoryMessages(
      boundAgentHistory(input, {
        prompt: effectivePrompt,
        systemPrompt: finalSystemPrompt,
        tools: toolDefinitions,
        imageCount: injectable.length,
      }),
      effectivePrompt,
    );
    effectivePrompt = history.prompt;
  } catch (error) {
    await mcpCleanup?.();
    input.onEvent({
      type: "error",
      content: error instanceof Error ? error.message : String(error),
    });
    input.onEvent({ type: "done" });
    return;
  }

  let turnCount = 0;
  // Summed across turns, not read off the last one. An agent loop is many model
  // calls, and pi reports each turn's own counts — reporting only the final turn
  // would bill a ten-step run as a one-step one.
  let promptTokens = 0;
  let completionTokens = 0;
  const agent = new Agent({
    initialState: {
      model,
      tools,
      systemPrompt: finalSystemPrompt,
      messages: toPiHistoryMessages(history.messages, model),
    },
    streamFn: (activeModel, context, options) => {
      assertAgentContext(
        input,
        { systemPrompt: context.systemPrompt, tools: toolDefinitions },
        context.messages,
      );
      return streamSimple(activeModel, context, options);
    },
    getApiKey: () => apiKey,
    toolExecution: "parallel",
  });

  let turnTextBuffer = "";

  // Map pi-agent-core events to our AgentEvent format
  agent.subscribe((event: PiAgentEvent) => {
    switch (event.type) {
      case "turn_end": {
        turnTextBuffer = "";

        turnCount++;
        // pi's `input` has the cache buckets taken OUT of it (see its
        // openai-completions provider: `input = prompt_tokens - cacheRead -
        // cacheWrite`), so they go back in here to make this the whole input the
        // model processed — the same figure the Anthropic path reports.
        if (event.message.role === "assistant") {
          const used = event.message.usage;
          promptTokens +=
            toCount(used?.input) + toCount(used?.cacheRead) + toCount(used?.cacheWrite);
          completionTokens += toCount(used?.output);
        }
        // Token budget guard: abort the run when cumulative token spend
        // exceeds the per-run budget. Checked before MAX_TURNS so the user
        // sees a budget error rather than a generic turn-limit message.
        if (input.tokenBudgetPerRun) {
          const totalSpent = promptTokens + completionTokens;
          if (totalSpent > input.tokenBudgetPerRun) {
            input.onEvent({
              type: "error",
              content: `Token 预算已用尽（已消耗 ${totalSpent.toLocaleString()} tokens，上限 ${input.tokenBudgetPerRun.toLocaleString()} tokens）`,
            });
            agent.abort();
            return;
          }
        }
        if (turnCount >= MAX_TURNS) {
          input.onEvent({
            type: "error",
            content: `Agent stopped: reached maximum of ${MAX_TURNS} turns`,
          });
          agent.abort();
        }
        break;
      }
      case "message_update": {
        // Buffer text deltas instead of immediately emitting. The buffer is
        // flushed as `reasoning` when a tool call follows (intermediate turn)
        // or as `final_text` when the turn ends without tool calls (final turn).
        const ame = event.assistantMessageEvent;
        if (ame.type === "text_delta") {
          turnTextBuffer += ame.delta;
          input.onEvent({ type: "final_text", content: ame.delta });
        } else if (ame.type === "toolcall_start") {
          // The model has started emitting a tool call. Its arguments JSON may
          // take seconds to stream, so flush the text into reasoning and show
          // the tool row (name only) now; `tool_execution_start` fills in the
          // input on the same row via `toolCallId` once the args are complete.
          const tc = ame.partial.content[ame.contentIndex];
          if (tc && tc.type === "toolCall") {
            if (turnTextBuffer) {
              input.onEvent({ type: "clear_streaming_text" });
              input.onEvent({ type: "reasoning", content: turnTextBuffer });
              turnTextBuffer = "";
            }
            input.onEvent({ type: "tool_start", toolName: tc.name, toolCallId: tc.id });
          }
        }
        break;
      }
      case "tool_execution_start":
        if (turnTextBuffer) {
          input.onEvent({ type: "clear_streaming_text" });
          input.onEvent({ type: "reasoning", content: turnTextBuffer });
          turnTextBuffer = "";
        }
        input.onEvent({
          type: "tool_start",
          toolName: event.toolName,
          toolInput: event.args,
          toolCallId: event.toolCallId,
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
          content: text.length > 8000 ? `${text.slice(0, 8000)}...` : text,
          toolName: event.toolName,
          toolCallId: event.toolCallId,
        });
        break;
      }
      case "agent_end": {
        turnTextBuffer = "";

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
  if (!input.abortController.signal.aborted) {
    input.abortController.signal.addEventListener("abort", onAbort, { once: true });
  }

  try {
    // Agent.prompt creates its own controller, so aborting the Agent before
    // prompt() does not cancel that future request. Recheck after async setup.
    if (input.abortController.signal.aborted) return;
    if (useVisionImages) {
      const piImages: ImageContent[] = injectable.map((img) => ({
        type: "image",
        data: img.dataBase64,
        mimeType: img.mediaType,
      }));
      await agent.prompt(effectivePrompt, piImages);
    } else {
      await agent.prompt(effectivePrompt);
    }
    await agent.waitForIdle();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    input.onEvent({ type: "error", content: msg });
  } finally {
    input.abortController.signal.removeEventListener("abort", onAbort);
    await mcpCleanup?.();
    if (checkpoint.files.size > 0) {
      try {
        await finalizeCheckpoint(checkpoint);
        input.onCheckpointReady?.();
      } catch {
        // best-effort
      }
    }
    const usage = buildUsageEvent(promptTokens, completionTokens);
    if (usage) input.onEvent(usage);
    input.onEvent({ type: "done" });
  }
}
