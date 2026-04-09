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
  requestApproval: (input: {
    toolUseId: string;
    toolName: string;
    toolInput: Record<string, unknown>;
    decisionReason?: string;
    blockedPath?: string;
  }) => Promise<boolean>;
  onEvent: (event: AgentEvent) => void;
  onCheckpointReady: (runId: string) => void;
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

export async function runClaudeAgent(input: RunClaudeAgentInput): Promise<void> {
  const sdk = await import("@anthropic-ai/claude-agent-sdk");

  // Per-run env. Critically, we do NOT mutate process.env here — sidecar
  // is a long-lived process and concurrent runs would race on a shared
  // ANTHROPIC_API_KEY. Instead we hand the credentials to the SDK via
  // its `options.env` field, which the SDK uses for the spawned child
  // process exclusively. The current sidecar process's env stays clean.
  const childEnv: Record<string, string | undefined> = {
    ...process.env,
  };
  if (input.apiKey) childEnv.ANTHROPIC_API_KEY = input.apiKey;
  if (input.baseUrl) childEnv.ANTHROPIC_BASE_URL = input.baseUrl;

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

  const query = sdk.query({
    prompt: input.prompt,
    options: {
      abortController: input.abortController,
      cwd: input.cwd,
      env: childEnv,
      model: input.model,
      executable: "bun",
      tools: ["Read", "Grep", "Glob", "Write", "Edit", "Bash"],
      permissionMode: "default",
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

        // SDK fs tools (Read/Write/Edit) bypass the sidecar's fs.* RPCs
        // and read/write the host filesystem directly. We re-apply the
        // workspace boundary check here so a model that names an
        // arbitrary path can't escape via Read or Write.
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
    },
  });

  for await (const message of query as AsyncIterable<SdkMessage>) {
    const event = convertSdkEvent(message);
    if (event) input.onEvent(event);
  }

  await finalizeCheckpoint(input.checkpoint);
  input.onCheckpointReady(input.checkpoint.runId);
  input.onEvent({ type: "done" });
}
