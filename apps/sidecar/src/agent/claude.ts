import type { CanUseTool, HookCallbackMatcher } from "@anthropic-ai/claude-agent-sdk";
import { type CheckpointSession, ensureCheckpointBackup, finalizeCheckpoint } from "../checkpoints";
import { classifyBashCommandRisk } from "../shell-risk";
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
  if (toolName === "Write" || toolName === "Edit") {
    const fp = input.file_path;
    if (typeof fp === "string" && fp.trim()) return fp;
  }
  return null;
}

export async function runClaudeAgent(input: RunClaudeAgentInput): Promise<void> {
  const sdk = await import("@anthropic-ai/claude-agent-sdk");

  const previousBaseUrl = process.env.ANTHROPIC_BASE_URL;
  const previousApiKey = process.env.ANTHROPIC_API_KEY;

  if (input.baseUrl) process.env.ANTHROPIC_BASE_URL = input.baseUrl;
  if (input.apiKey) process.env.ANTHROPIC_API_KEY = input.apiKey;

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
      apiKey: input.apiKey,
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

        if (options?.blockedPath) {
          return { behavior: "deny", message: `Blocked path: ${options.blockedPath}` } as const;
        }

        return { behavior: "allow" } as const;
      },
      hooks,
    },
  });

  try {
    for await (const message of query as AsyncIterable<SdkMessage>) {
      const event = convertSdkEvent(message);
      if (event) input.onEvent(event);
    }
  } finally {
    if (previousBaseUrl === undefined) delete process.env.ANTHROPIC_BASE_URL;
    else process.env.ANTHROPIC_BASE_URL = previousBaseUrl;
    if (previousApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previousApiKey;
  }

  await finalizeCheckpoint(input.checkpoint);
  input.onCheckpointReady(input.checkpoint.runId);
  input.onEvent({ type: "done" });
}
