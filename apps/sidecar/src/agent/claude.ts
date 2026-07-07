import path from "node:path";
import type { CanUseTool, HookCallbackMatcher } from "@anthropic-ai/claude-agent-sdk";
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
import { type AgentEvent, convertSdkEvent } from "./events";
import { buildIntentContext } from "./intent-context";
import { buildSkillsPromptSection, type MaterializedSkill } from "./skills";
import { buildAgentSystemPrompt } from "./system-prompt";

type SdkMessage = {
  type: string;
  [key: string]: unknown;
};

type CanUseToolOptions = Parameters<CanUseTool>[2];

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
   */
  mcpServers?: Record<string, Record<string, unknown>>;
  conversationHistory?: Array<{ role: "user" | "assistant"; content: string }>;
  attachments?: AttachmentPart[];
  /**
   * Enabled skills already materialized to the workspace. Surfaced to the model
   * as a Level-1 metadata block (read on demand via the SDK's `Read` tool).
   */
  skills?: MaterializedSkill[];
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

async function findClaudeBinary(): Promise<string> {
  const { execSync } = await import("node:child_process");
  try {
    return execSync("which claude", { timeout: 5000 }).toString().trim();
  } catch {
    return "claude";
  }
}

let cachedSdk: typeof import("@anthropic-ai/claude-agent-sdk") | null = null;
async function getSdk() {
  if (!cachedSdk) cachedSdk = await import("@anthropic-ai/claude-agent-sdk");
  return cachedSdk;
}
// Eagerly warm the SDK import so the first agent run doesn't pay the cost.
void getSdk();

export async function runClaudeAgent(input: RunClaudeAgentInput): Promise<void> {
  const sdk = await getSdk();

  // Per-run env. Critically, we do NOT mutate process.env here — sidecar
  // is a long-lived process and concurrent runs would race on a shared
  // ANTHROPIC_API_KEY. Instead we hand the credentials to the SDK via
  // its `options.env` field, which the SDK uses for the spawned child
  // process exclusively. The current sidecar process's env stays clean.
  const childEnv: Record<string, string | undefined> = {
    ...process.env,
  };
  for (const key of Object.keys(childEnv)) {
    if (
      key.startsWith("CLAUDE") ||
      key === "AI_AGENT" ||
      key.startsWith("CODEX_COMPANION") ||
      key.startsWith("TRELLIS_")
    ) {
      delete childEnv[key];
    }
  }
  const isOAuthToken =
    input.apiKey?.startsWith("sk-ant-oat") || input.apiKey?.startsWith("__cli_oauth__");
  if (input.apiKey && !isOAuthToken) childEnv.ANTHROPIC_API_KEY = input.apiKey;
  if (input.baseUrl && !isOAuthToken) childEnv.ANTHROPIC_BASE_URL = input.baseUrl;

  const hooks: Partial<Record<string, HookCallbackMatcher[]>> = {
    PreToolUse: [
      {
        hooks: [
          async (hookInput) => {
            if (!hookInput || typeof hookInput !== "object") return { continue: true };
            const data = hookInput as Record<string, unknown>;
            const toolName = typeof data.tool_name === "string" ? data.tool_name : "";
            const filePath = extractTargetFilePath(toolName, data.tool_input);
            if (filePath) {
              try {
                await ensureCheckpointBackup(input.checkpoint, filePath);
              } catch {
                // Best-effort: do not block tool execution on checkpoint failures.
              }
            }
            return { continue: true };
          },
        ],
      },
    ],
  };

  // Merge user system prompt with intent context (time / weather)
  const intentResult = await buildIntentContext(input.prompt, {
    webSearchEnabled: input.webSearchEnabled,
  });
  const finalSystemPrompt = [
    buildAgentSystemPrompt({
      cwd: input.cwd,
      permissionMode: input.permissionMode ?? "full-access",
      extra: buildSkillsPromptSection(input.skills ?? [], "Read"),
    }),
    input.systemPrompt,
    intentResult.context,
  ]
    .filter(Boolean)
    .join("\n\n");

  // Build tools list, conditionally including web tools
  const sdkTools: string[] = ["Read", "Grep", "Glob", "Write", "Edit", "Bash"];
  if (input.webSearchEnabled !== false) {
    sdkTools.push("WebFetch", "WebSearch");
  }

  const queryOptions: Record<string, unknown> = {
    abortController: input.abortController,
    cwd: input.cwd,
    env: childEnv,
    model: input.model,
    pathToClaudeCodeExecutable: await findClaudeBinary(),
    tools: sdkTools,
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    promptSuggestions: false,
    includePartialMessages: true,
    ...(finalSystemPrompt ? { systemPrompt: finalSystemPrompt } : {}),
    ...(input.mcpServers && Object.keys(input.mcpServers).length > 0
      ? { mcpServers: input.mcpServers }
      : {}),
    canUseTool: async (
      toolName: string,
      toolInput: Record<string, unknown>,
      options: CanUseToolOptions,
    ) => {
      if (toolName === "Bash") {
        const cmd = typeof toolInput.command === "string" ? toolInput.command : "";
        const risk = classifyBashCommandRisk(cmd);
        if (risk.level === "allow") {
          return { behavior: "allow" } as const;
        }
        const allow = await input.requestApproval({
          toolUseId: options.toolUseID,
          toolName,
          toolInput,
          decisionReason: risk.reason || options.decisionReason,
          blockedPath: options.blockedPath,
        });
        return allow
          ? ({ behavior: "allow" } as const)
          : ({ behavior: "deny", message: "User denied command" } as const);
      }

      const fsDeny = await checkSdkFsToolPath(
        toolName,
        toolInput,
        input.cwd,
        (input.skills ?? []).map((s) => s.skillDir),
      );
      if (fsDeny !== null) {
        return { behavior: "deny", message: fsDeny } as const;
      }

      if (options?.blockedPath) {
        return { behavior: "deny", message: `Blocked path: ${options.blockedPath}` } as const;
      }

      return { behavior: "allow" } as const;
    },
    hooks,
  };

  if (input.sdkSessionId) {
    queryOptions.resume = input.sdkSessionId;
  }

  // Claude Agent SDK only accepts a single prompt string. When we have
  // conversation history we prepend it as structured context so the
  // agent understands the prior turns without polluting the user's
  // visible message in the UI.
  let effectivePrompt = input.prompt;
  if (input.conversationHistory && input.conversationHistory.length > 0) {
    const historyBlock = input.conversationHistory
      .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
      .join("\n\n");
    effectivePrompt = `${historyBlock}\n\n---\n\nUser: ${input.prompt}`;
  }
  // Inject file attachment text (works for every model regardless of vision).
  const fileContext = buildFileContext(input.attachments);
  if (fileContext) effectivePrompt += fileContext;

  // Image attachments: send real content blocks to vision-capable models,
  // otherwise degrade to a textual placeholder so the run never errors. Images
  // whose format the provider rejects (bmp/svg/heic …) also degrade to text.
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

  // Build the prompt input: a plain string normally, or an async-iterable
  // single user message carrying image content blocks for vision runs.
  let promptInput: Parameters<typeof sdk.query>[0]["prompt"] = effectivePrompt;
  if (useVisionImages) {
    const content: Array<Record<string, unknown>> = [{ type: "text", text: effectivePrompt }];
    for (const img of injectable) {
      content.push({
        type: "image",
        source: { type: "base64", media_type: img.mediaType, data: img.dataBase64 },
      });
    }
    const userMessage = {
      type: "user",
      message: { role: "user", content },
      parent_tool_use_id: null,
      session_id: input.sdkSessionId ?? "",
    };
    promptInput = (async function* () {
      yield userMessage;
    })() as Parameters<typeof sdk.query>[0]["prompt"];
  }

  const query = sdk.query({
    prompt: promptInput,
    options: queryOptions as Parameters<typeof sdk.query>[0]["options"],
  });

  let capturedSessionId: string | null = null;
  try {
    for await (const message of query as AsyncIterable<SdkMessage>) {
      if (
        !capturedSessionId &&
        message.type === "system" &&
        typeof message.session_id === "string"
      ) {
        capturedSessionId = message.session_id;
        input.onSdkSessionId(capturedSessionId);
      }
      const events = convertSdkEvent(message);
      if (events) {
        if (Array.isArray(events)) {
          for (const e of events) input.onEvent(e);
        } else {
          input.onEvent(events);
        }
      }
    }
  } finally {
    // Always finalize the checkpoint when this run actually backed up files,
    // even on abort (SDK throws AbortError) or a mid-stream throw. Otherwise
    // manifest.json is never written and rollbackCheckpoint() fails with
    // ENOENT exactly when the user cancels a run that already edited files.
    // Best-effort: a finalize failure must not mask the original abort/error.
    if (input.checkpoint.files.size > 0) {
      try {
        await finalizeCheckpoint(input.checkpoint);
        input.onCheckpointReady(input.checkpoint.runId);
      } catch {
        // swallow — preserve the original completion/abort/error outcome
      }
    }
  }

  input.onEvent({ type: "done" });
}
