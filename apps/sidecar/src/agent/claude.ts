import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import type { AttachmentPart } from "shared/types";
import { modelSupportsVision } from "shared/vision";
import { type CheckpointSession, ensureCheckpointBackup, finalizeCheckpoint } from "../checkpoints";
import { classifyBashCommandRisk } from "../shell-risk";
import {
  resolvePathInsideWorkspace,
  resolveWritePathInsideWorkspace,
  toWorkspaceRelative,
} from "../workspace";
import {
  buildFileContext,
  getImageAttachments,
  imageFallbackText,
  imageUnsupportedFormatText,
  partitionImagesByFormat,
} from "./attachments";
import { HISTORY_MAX_TOKENS, truncateHistory } from "./context";
import { executeTool } from "./direct";
import { type AgentEvent, buildUsageEvent, toCount } from "./events";
import { buildIntentContext } from "./intent-context";
import { buildSkillsPromptSection, type MaterializedSkill } from "./skills";
import { buildAgentSystemPrompt, buildReActBehaviorSection } from "./system-prompt";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SdkMessage = {
  type: string;
  [key: string]: unknown;
};

export type RunClaudeAgentInput = {
  apiKey: string;
  baseUrl?: string;
  model: string;
  prompt: string;
  cwd: string;
  abortController: AbortController;
  checkpoint: CheckpointSession;
  sdkSessionId?: string;
  permissionMode?: "default" | "full-access";
  systemPrompt?: string;
  webSearchEnabled?: boolean;
  /**
   * Enabled MCP servers, keyed by name, already in the Claude Agent SDK's
   * shape (`{ type, command, args, env }` for stdio; `{ type, url, headers }`
   * for http/sse). The SDK launches stdio servers itself and exposes their
   * tools to the model — they're additive to the built-in `tools` allowlist.
   *
   * NOTE: MCP tools are NOT yet wired into the self-managed loop. They still
   * require the Claude Agent SDK path. This is noted as out-of-scope in the
   * PRD and will be migrated separately.
   */
  mcpServers?: Record<string, Record<string, unknown>>;
  conversationHistory?: Array<{ role: "user" | "assistant"; content: string }>;
  attachments?: AttachmentPart[];
  /**
   * Enabled skills already materialized to the workspace. Surfaced to the model
   * as a Level-1 metadata block (read on demand via the `Read` tool).
   */
  skills?: MaterializedSkill[];
  /** Per-run token budget. When cumulative tokens exceed this limit the run is aborted. */
  tokenBudgetPerRun?: number;
  requestApproval: (input: {
    toolUseId: string;
    toolName: string;
    toolInput: Record<string, unknown>;
    decisionReason?: string;
    blockedPath?: string;
  }) => Promise<boolean>;
  onEvent: (event: AgentEvent) => void;
  onCheckpointReady: (runId: string) => void;
  onSdkSessionId: (sessionId: string) => void;
};

// ---------------------------------------------------------------------------
// Existing helper functions (exported for tests — UNCHANGED)
// ---------------------------------------------------------------------------

function extractTargetFilePath(toolName: string, toolInput: unknown): string | null {
  if (!toolInput || typeof toolInput !== "object") return null;
  const input = toolInput as Record<string, unknown>;
  if (toolName === "Write" || toolName === "Edit" || toolName === "Read") {
    const fp = input.file_path;
    if (typeof fp === "string" && fp.trim()) return fp;
  }
  return null;
}

/**
 * Returns null if the SDK fs tool target is safely inside the workspace,
 * or a deny reason otherwise. Bash is handled separately and is not
 * routed through this helper.
 *
 * Exported for unit tests so we can verify the workspace boundary
 * without spinning up the full SDK query loop.
 */
export async function checkSdkFsToolPath(
  toolName: string,
  toolInput: unknown,
  workspaceRoot: string,
  readAllowRoots: string[] = [],
): Promise<string | null> {
  const filePath = extractTargetFilePath(toolName, toolInput);
  if (!filePath) return null;

  // Skills are read in place from their real folders (Claude-style), which live
  // outside the workspace. Allow READ tools within any enabled skill folder;
  // Write/Edit stay strictly workspace-bounded.
  if (toolName !== "Write" && toolName !== "Edit" && readAllowRoots.length > 0) {
    const abs = path.isAbsolute(filePath)
      ? path.resolve(filePath)
      : path.resolve(workspaceRoot, filePath);
    for (const root of readAllowRoots) {
      const r = path.resolve(root);
      if (abs === r || abs.startsWith(`${r}${path.sep}`)) return null;
    }
  }

  try {
    const relative = toWorkspaceRelative(workspaceRoot, filePath);
    if (toolName === "Write" || toolName === "Edit") {
      // Write/Edit needs the realpath-of-ancestor check so symlinks can't
      // be planted inside the workspace to escape on first write.
      await resolveWritePathInsideWorkspace({
        workspaceRoot,
        targetPath: relative,
      });
    } else {
      // Read: lexical check is enough — we don't follow symlinks for read,
      // and assertExistingPathInsideWorkspace would block too aggressively
      // when the model speculatively reads non-existent files.
      resolvePathInsideWorkspace({
        workspaceRoot,
        targetPath: relative,
      });
    }
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : "Path escapes workspace";
  }
}

/**
 * Extracts the bare hostname (without scheme / port / path) from a URL,
 * returning null if the input doesn't parse. Used to build a minimal
 * sandbox network allow-list — we don't want to grant `*.anthropic.com`
 * across the board, only the specific host the user configured.
 *
 * Exported for testing.
 */
export function extractHostname(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}

export const DEFAULT_ANTHROPIC_HOST = "api.anthropic.com";

/**
 * Builds the sandbox network allow-list from an optional user-provided
 * baseUrl. Always includes the default Anthropic host as a fallback so
 * SDK requests still work even if the user clears their custom relay.
 *
 * Exported for testing.
 */
export function buildNetworkAllowedDomains(baseUrl: string | undefined): string[] {
  const userHost = extractHostname(baseUrl);
  return Array.from(new Set([userHost ?? DEFAULT_ANTHROPIC_HOST, DEFAULT_ANTHROPIC_HOST]));
}

// ---------------------------------------------------------------------------
// Kept for rollback — not used in the self-managed loop
// ---------------------------------------------------------------------------

/** Locate the `claude` CLI on PATH for the SDK to spawn. */
async function findClaudeBinary(): Promise<string> {
  const { execSync } = await import("node:child_process");
  try {
    return execSync("which claude", { timeout: 5000 }).toString().trim();
  } catch {
    return "claude";
  }
}

// ---------------------------------------------------------------------------
// Self-managed agent loop — constants
// ---------------------------------------------------------------------------

/** Maximum number of agent turns before forced stop (prevents infinite loops). */
const MAX_TURNS = 30;

/** Default max output tokens per API call. */
const DEFAULT_MAX_TOKENS = 16384;

// ---------------------------------------------------------------------------
// Tool definitions for the Anthropic Messages API
// ---------------------------------------------------------------------------

/**
 * Tool definitions use PascalCase names matching Claude Code conventions:
 * Read, Write, Edit, Bash, Grep, Glob, WebSearch, WebFetch. The model is
 * familiar with these names and their parameter shapes.
 */
function buildAnthropicTools(opts?: {
  webSearchEnabled?: boolean;
}): Array<Record<string, unknown>> {
  const tools: Array<Record<string, unknown>> = [
    {
      name: "Read",
      description:
        "Read the contents of a file at the given path. Use this to examine file contents, check configurations, or understand code structure.",
      input_schema: {
        type: "object",
        properties: {
          file_path: {
            type: "string",
            description: "The absolute path to the file to read",
          },
        },
        required: ["file_path"],
      },
    },
    {
      name: "Write",
      description:
        "Create or overwrite a file with the given content. Use this for new files or complete rewrites. For partial edits, prefer the Edit tool.",
      input_schema: {
        type: "object",
        properties: {
          file_path: {
            type: "string",
            description: "The absolute path to the file to write",
          },
          content: {
            type: "string",
            description: "The content to write to the file",
          },
        },
        required: ["file_path", "content"],
      },
    },
    {
      name: "Edit",
      description:
        "Edit a file by replacing the first occurrence of an exact string match. Use this for precise modifications to existing files. If the string appears multiple times, only the first match is replaced.",
      input_schema: {
        type: "object",
        properties: {
          file_path: {
            type: "string",
            description: "The absolute path to the file to modify",
          },
          old_string: {
            type: "string",
            description: "The exact string to find and replace",
          },
          new_string: {
            type: "string",
            description: "The replacement string",
          },
        },
        required: ["file_path", "old_string", "new_string"],
      },
    },
    {
      name: "Bash",
      description:
        "Run a shell command and return its output. Use this for file operations, git commands, package management, building, testing, and any other shell tasks.",
      input_schema: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "The shell command to execute",
          },
        },
        required: ["command"],
      },
    },
    {
      name: "Grep",
      description:
        "Search for a text pattern in files. Returns matching lines with file paths and line numbers.",
      input_schema: {
        type: "object",
        properties: {
          pattern: {
            type: "string",
            description: "Search pattern (literal string or regex)",
          },
          path: {
            type: "string",
            description: "Directory or file to search in. Defaults to '.'",
          },
          include: {
            type: "string",
            description: "File glob pattern to filter, e.g. '*.ts'",
          },
        },
        required: ["pattern"],
      },
    },
    {
      name: "Glob",
      description: "Find files matching a glob pattern. Returns a list of matching file paths.",
      input_schema: {
        type: "object",
        properties: {
          pattern: {
            type: "string",
            description: "Glob pattern, e.g. '**/*.ts', 'src/**/*.json'",
          },
        },
        required: ["pattern"],
      },
    },
  ];

  if (opts?.webSearchEnabled !== false) {
    tools.push(
      {
        name: "WebSearch",
        description:
          "Search the web for information. Use this when you need current or real-time data.",
        input_schema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "The search query",
            },
          },
          required: ["query"],
        },
      },
      {
        name: "WebFetch",
        description:
          "Fetch a web page and return its content as Markdown. Use this to read documentation, articles, or any web content.",
        input_schema: {
          type: "object",
          properties: {
            url: {
              type: "string",
              description: "The URL to fetch",
            },
          },
          required: ["url"],
        },
      },
    );
  }

  return tools;
}

// ---------------------------------------------------------------------------
// Tool name/parameter mapping from Claude conventions to executeTool format
// ---------------------------------------------------------------------------

/**
 * Maps PascalCase tool names and parameter conventions used by the Anthropic
 * Messages API (Read/Write/Edit with `file_path`) to the snake_case names and
 * parameter shapes expected by `executeTool` from `direct.ts` (read_file with
 * `path`, etc.).
 */
function mapToolForExecution(
  toolName: string,
  toolInput: Record<string, unknown>,
): { executorName: string; executorInput: Record<string, unknown> } {
  switch (toolName) {
    case "Read":
      return { executorName: "read_file", executorInput: { path: toolInput.file_path } };
    case "Write":
      return {
        executorName: "write_file",
        executorInput: { path: toolInput.file_path, content: toolInput.content },
      };
    case "Edit":
      return {
        executorName: "edit_file",
        executorInput: {
          path: toolInput.file_path,
          old_string: toolInput.old_string,
          new_string: toolInput.new_string,
        },
      };
    case "Bash":
      return { executorName: "bash", executorInput: { command: toolInput.command } };
    case "Grep":
      return { executorName: "grep", executorInput: toolInput };
    case "Glob":
      return { executorName: "glob", executorInput: toolInput };
    case "WebSearch":
      return { executorName: "web_search", executorInput: { query: toolInput.query } };
    case "WebFetch":
      return { executorName: "web_fetch", executorInput: { url: toolInput.url } };
    default:
      return { executorName: toolName, executorInput: toolInput };
  }
}

// ---------------------------------------------------------------------------
// Main entry point — self-managed Messages API loop
// ---------------------------------------------------------------------------

/**
 * Runs a Claude agent using the Anthropic Messages API directly, with a
 * self-managed agent loop. This replaces the old Claude Agent SDK `query()`
 * approach, giving us access to intermediate reasoning text between tool
 * call rounds for true ReAct display.
 *
 * Tool execution reuses `executeTool` from `direct.ts` — the same battle-tested
 * code that powers the generic tool-calling runtime. Workspace boundary checks,
 * checkpoint backups, and Bash approval are handled identically to the old SDK
 * path.
 */
export async function runClaudeAgent(input: RunClaudeAgentInput): Promise<void> {
  const anthropic = new Anthropic({
    apiKey: input.apiKey,
    ...(input.baseUrl ? { baseURL: input.baseUrl } : {}),
  });

  // Merge user system prompt with intent context (time / weather)
  const intentResult = await buildIntentContext(input.prompt, {
    webSearchEnabled: input.webSearchEnabled,
  });
  const finalSystemPrompt = [
    buildAgentSystemPrompt({
      cwd: input.cwd,
      permissionMode: input.permissionMode ?? "full-access",
      webFetchAvailable: input.webSearchEnabled !== false,
      extra: buildSkillsPromptSection(input.skills ?? [], "Read"),
    }),
    buildReActBehaviorSection(),
    input.systemPrompt,
    intentResult.context,
  ]
    .filter(Boolean)
    .join("\n\n");

  // Build tool definitions
  const anthropicTools = buildAnthropicTools({ webSearchEnabled: input.webSearchEnabled });

  // Skill read-allow roots for workspace boundary checks
  const skillRoots = (input.skills ?? []).map((s) => s.skillDir);

  // Build effective prompt with history + attachments
  let effectivePrompt = input.prompt;
  if (input.conversationHistory && input.conversationHistory.length > 0) {
    const trimmed = truncateHistory(input.conversationHistory, HISTORY_MAX_TOKENS);
    const historyBlock = trimmed
      .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
      .join("\n\n");
    effectivePrompt = `${historyBlock}\n\n---\n\nUser: ${input.prompt}`;
  }
  // Inject file attachment text (works for every model regardless of vision).
  const fileContext = buildFileContext(input.attachments);
  if (fileContext) effectivePrompt += fileContext;

  // Image attachments: send real content blocks to vision-capable models,
  // otherwise degrade to a textual placeholder so the run never errors.
  const images = getImageAttachments(input.attachments);
  const supportsVision = modelSupportsVision(input.model);
  const { injectable, unsupported } = supportsVision
    ? partitionImagesByFormat(images)
    : { injectable: [], unsupported: [] };
  const useVisionImages = injectable.length > 0;
  if (!supportsVision && images.length > 0) {
    effectivePrompt += imageFallbackText(images);
  }
  if (unsupported.length > 0) {
    effectivePrompt += imageUnsupportedFormatText(unsupported);
  }

  // Build the initial user message. For vision-capable models with images,
  // use a multi-block content array; otherwise a plain string.
  let initialUserContent: string | Array<Record<string, unknown>> = effectivePrompt;
  if (useVisionImages) {
    const blocks: Array<Record<string, unknown>> = [{ type: "text", text: effectivePrompt }];
    for (const img of injectable) {
      blocks.push({
        type: "image",
        source: { type: "base64", media_type: img.mediaType, data: img.dataBase64 },
      });
    }
    initialUserContent = blocks;
  }

  // Messages array for the API loop — grows as the agent interacts
  const messages: Array<{ role: "user" | "assistant"; content: unknown }> = [
    { role: "user", content: initialUserContent },
  ];

  let turnCount = 0;
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;

  try {
    while (turnCount < MAX_TURNS) {
      // Create a streaming request to the Anthropic Messages API
      const stream = anthropic.messages.stream(
        {
          model: input.model,
          max_tokens: DEFAULT_MAX_TOKENS,
          system: finalSystemPrompt,
          messages: messages as Anthropic.MessageParam[],
          tools: anthropicTools as unknown as Anthropic.Tool[],
        },
        { signal: input.abortController.signal },
      );

      // Stream text deltas to the UI in real-time
      let textBuf = "";
      stream.on("text", (text: string) => {
        textBuf += text;
        input.onEvent({ type: "final_text", content: text });
      });

      // Wait for the complete response
      let response: Anthropic.Message;
      try {
        response = await stream.finalMessage();
      } catch (err) {
        // Abort: re-throw so the guard in index.ts handles it (emits done)
        if (input.abortController.signal.aborted) throw err;
        // API error: emit error event and stop the loop gracefully
        input.onEvent({
          type: "error",
          content: err instanceof Error ? err.message : String(err),
        });
        break;
      }

      // Accumulate token usage across turns.
      // Anthropic reports cache reads/writes separately from input_tokens,
      // so we sum all buckets for the full input figure (same as the old path).
      const usage = response.usage as unknown as Record<string, unknown>;
      totalPromptTokens +=
        toCount(usage.input_tokens) +
        toCount(usage.cache_creation_input_tokens) +
        toCount(usage.cache_read_input_tokens);
      totalCompletionTokens += toCount(usage.output_tokens);

      // Token budget guard: abort the run when cumulative token spend
      // exceeds the per-run budget.
      if (input.tokenBudgetPerRun) {
        const totalSpent = totalPromptTokens + totalCompletionTokens;
        if (totalSpent > input.tokenBudgetPerRun) {
          input.onEvent({
            type: "error",
            content: `Token 预算已用尽（已消耗 ${totalSpent.toLocaleString()} tokens，上限 ${input.tokenBudgetPerRun.toLocaleString()} tokens）`,
          });
          break;
        }
      }

      // Any stop reason other than tool_use means the conversation is done
      if (response.stop_reason !== "tool_use") {
        break;
      }

      // ---------------------------------------------------------------
      // stop_reason === "tool_use": execute tools and continue the loop
      // ---------------------------------------------------------------

      // The text streamed so far was intermediate reasoning (the model was
      // thinking before deciding to call tools). Convert it from final_text
      // (which the UI renders as the chat reply) to reasoning (which the UI
      // renders in the collapsible agent reasoning section).
      if (textBuf) {
        input.onEvent({ type: "clear_streaming_text" });
        input.onEvent({ type: "reasoning", content: textBuf });
        textBuf = "";
      }

      // Extract tool_use blocks from the response
      const toolUseBlocks = response.content.filter(
        (b): b is Anthropic.ContentBlock & { type: "tool_use"; id: string; name: string } =>
          b.type === "tool_use",
      );

      // Defensive: if stop_reason is tool_use but no blocks exist, bail
      if (toolUseBlocks.length === 0) {
        break;
      }

      const toolResults: Array<{
        type: "tool_result";
        tool_use_id: string;
        content: string;
        is_error?: boolean;
      }> = [];

      for (const block of toolUseBlocks) {
        const toolInput = (block.input || {}) as Record<string, unknown>;

        // Emit tool_start so the UI shows the tool being invoked
        input.onEvent({ type: "tool_start", toolName: block.name, toolInput });

        // --- Workspace boundary check for fs tools (Read/Write/Edit) ---
        const fsDeny = await checkSdkFsToolPath(block.name, toolInput, input.cwd, skillRoots);
        if (fsDeny !== null) {
          input.onEvent({ type: "tool_result", content: fsDeny });
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: fsDeny,
            is_error: true,
          });
          continue;
        }

        // --- Bash approval for risky commands ---
        if (block.name === "Bash") {
          const cmd = typeof toolInput.command === "string" ? toolInput.command : "";
          const risk = classifyBashCommandRisk(cmd);
          if (risk.level !== "allow") {
            const allowed = await input.requestApproval({
              toolUseId: block.id,
              toolName: "Bash",
              toolInput,
              decisionReason: risk.reason,
            });
            if (!allowed) {
              const denyMsg = "User denied command";
              input.onEvent({ type: "tool_result", content: denyMsg });
              toolResults.push({
                type: "tool_result",
                tool_use_id: block.id,
                content: denyMsg,
                is_error: true,
              });
              continue;
            }
          }
        }

        // --- Checkpoint backup for file-modifying tools (before execution) ---
        // Mirrors the old PreToolUse hook: convert the absolute path to a
        // workspace-relative one so ensureCheckpointBackup can normalise it.
        const filePath = extractTargetFilePath(block.name, toolInput);
        if (filePath) {
          try {
            const relPath = toWorkspaceRelative(input.checkpoint.workspaceRoot, filePath);
            await ensureCheckpointBackup(input.checkpoint, relPath);
          } catch (error) {
            console.error(
              `[claude-agent] checkpoint backup failed for ${filePath}:`,
              error instanceof Error ? error.message : error,
            );
          }
        }

        // --- Map tool name/params and execute ---
        const mapped = mapToolForExecution(block.name, toolInput);
        const result = await executeTool(mapped.executorName, mapped.executorInput, input.cwd, {
          permissionMode: "full-access",
          checkpoint: input.checkpoint,
          readAllowRoots: skillRoots,
        });

        input.onEvent({
          type: "tool_result",
          content: result.length > 8000 ? `${result.slice(0, 8000)}...` : result,
        });
        toolResults.push({ type: "tool_result", tool_use_id: block.id, content: result });
      }

      // Append the assistant's response and the tool results to the message
      // history so the model can see what happened on the next iteration.
      messages.push({ role: "assistant", content: response.content });
      messages.push({ role: "user", content: toolResults });

      turnCount++;
      if (turnCount >= MAX_TURNS) {
        input.onEvent({
          type: "error",
          content: `Agent stopped: reached maximum of ${MAX_TURNS} turns`,
        });
      }
    }
  } finally {
    // Always finalize the checkpoint when this run actually backed up files,
    // even on abort or a mid-stream throw. Otherwise manifest.json is never
    // written and rollbackCheckpoint() fails with ENOENT.
    if (input.checkpoint.files.size > 0) {
      try {
        await finalizeCheckpoint(input.checkpoint);
        input.onCheckpointReady(input.checkpoint.runId);
      } catch {
        // swallow — preserve the original completion/abort/error outcome
      }
    }
  }

  // Emit final usage + done events. If the function threw (e.g. abort),
  // these are never reached — the guard in index.ts handles that case.
  const usageEvent = buildUsageEvent(totalPromptTokens, totalCompletionTokens);
  if (usageEvent) input.onEvent(usageEvent);
  input.onEvent({ type: "done" });
}
