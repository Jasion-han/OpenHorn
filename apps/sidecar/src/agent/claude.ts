import type { CanUseTool, HookCallbackMatcher } from "@anthropic-ai/claude-agent-sdk";
import { type CheckpointSession, ensureCheckpointBackup, finalizeCheckpoint } from "../checkpoints";
import { classifyBashCommandRisk } from "../shell-risk";
import {
  resolvePathInsideWorkspace,
  resolveWritePathInsideWorkspace,
} from "../workspace";
import { type AgentEvent, convertSdkEvent } from "./events";

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
 * Returns the workspace-relative form of an absolute or relative path the
 * SDK passes us. SDK fs tools (Read/Write/Edit) tend to send absolute
 * paths because the model is told to use the workspace cwd, but we
 * normalize defensively.
 */
function toWorkspaceRelative(workspaceRoot: string, candidate: string): string {
  if (candidate.startsWith("/")) {
    // Absolute path: convert to relative to workspace root. The
    // resolvePath* helpers reject absolutes outright, but if the
    // absolute path happens to live inside the workspace we still want
    // to allow it after normalization.
    const rootWithSep = workspaceRoot.endsWith("/") ? workspaceRoot : `${workspaceRoot}/`;
    if (candidate === workspaceRoot) return ".";
    if (candidate.startsWith(rootWithSep)) {
      return candidate.slice(rootWithSep.length);
    }
    // Outside workspace; leaving it absolute will make resolvePath* throw,
    // which is exactly what we want.
    return candidate;
  }
  return candidate;
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
): Promise<string | null> {
  const filePath = extractTargetFilePath(toolName, toolInput);
  if (!filePath) return null;

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
    if (key.startsWith("CLAUDE") || key === "AI_AGENT" || key.startsWith("CODEX_COMPANION") || key.startsWith("TRELLIS_")) {
      delete childEnv[key];
    }
  }
  const isCliOAuth = input.apiKey?.startsWith("__cli_oauth__");
  if (input.apiKey && !isCliOAuth) childEnv.ANTHROPIC_API_KEY = input.apiKey;
  if (input.baseUrl && !isCliOAuth) childEnv.ANTHROPIC_BASE_URL = input.baseUrl;

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

  const queryOptions: Record<string, unknown> = {
    abortController: input.abortController,
    cwd: input.cwd,
    env: childEnv,
    model: input.model,
    pathToClaudeCodeExecutable: await findClaudeBinary(),
    tools: ["Read", "Grep", "Glob", "Write", "Edit", "Bash"],
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    promptSuggestions: false,
    includePartialMessages: true,
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

      const fsDeny = await checkSdkFsToolPath(toolName, toolInput, input.cwd);
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

  const query = sdk.query({
    prompt: input.prompt,
    options: queryOptions as Parameters<typeof sdk.query>[0]["options"],
  });

  let capturedSessionId: string | null = null;
  for await (const message of query as AsyncIterable<SdkMessage>) {
    if (!capturedSessionId && message.type === "system" && typeof message.session_id === "string") {
      capturedSessionId = message.session_id;
      input.onSdkSessionId(capturedSessionId);
    }
    const event = convertSdkEvent(message);
    if (event) input.onEvent(event);
  }

  await finalizeCheckpoint(input.checkpoint);
  input.onCheckpointReady(input.checkpoint.runId);
  input.onEvent({ type: "done" });
}
