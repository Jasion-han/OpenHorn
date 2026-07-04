import { useRef, useState } from "react";
import type { AttachmentPart } from "shared/types";
import { createServerApi } from "../lib/serverApi";
import type { SidecarApprovalRequest } from "../lib/sidecarClient";
import { discoverSkills, skillsDisabledList } from "../lib/tauriBridge";
import { useChatStore } from "../stores/chatStore";
import { useSidecarStore } from "../stores/sidecarStore";

const api = createServerApi();

/** Skill metadata sent with a run — read in place from `path` (Claude-style). */
interface SkillMeta {
  name: string;
  description: string;
  path: string;
}

/**
 * Resolve the user's enabled skills to send with a run. Skills are discovered
 * as real folders across the known locations (cc-switch, Claude Code, Codex,
 * Gemini) minus the user-disabled set, and read IN PLACE — the run carries each
 * skill's name/description + absolute folder path; nothing is copied.
 */
async function resolveEnabledSkills(): Promise<SkillMeta[]> {
  const [discovered, disabled] = await Promise.all([discoverSkills(), skillsDisabledList()]);
  const disabledSet = new Set(disabled.map((n) => n.trim().toLowerCase()));
  return (discovered ?? [])
    .filter((s) => !disabledSet.has(s.name.trim().toLowerCase()))
    .map((s) => ({
      name: s.name,
      description: (s.description ?? "").replace(/\s+/g, " ").trim(),
      path: s.path,
    }));
}

/**
 * Identity of the sidecar agent run that is currently bound to a
 * specific assistant message. When a sidecar run ends (done / error /
 * cancel) we drop this association so the message can be retried or
 * a new run can start.
 */
interface ActiveSidecarRun {
  runId: string;
  messageId: string;
  conversationId: string;
}

export interface SidecarAgentRunInput {
  conversationId: string;
  channelId: string;
  modelId: string;
  assistantMessageId: string;
  prompt: string;
  // What the user's bubble should show/store. `prompt` may carry a slash-command
  // instruction wrapper for the model; this is the clean typed content (with the
  // `/skill` token preserved) so reloaded conversations match what was sent.
  displayContent?: string;
  // Edit-and-resend: when both point at existing persisted rows, the round is
  // updated in place instead of inserting a new pair (avoids duplicate rounds).
  existingUserMessageId?: string;
  existingAssistantMessageId?: string;
  sdkSessionId?: string;
  permissionMode?: "default" | "full-access";
  systemPrompt?: string;
  webSearchEnabled?: boolean;
  tavilyApiKey?: string;
  // Set when the user invoked an MCP server via `/server`: the run connects to
  // that single server only (case-insensitive name match) instead of the full
  // enabled roster — faster startup and its tools can't fall past the tool cap.
  targetMcpServer?: string;
  conversationHistory?: Array<{ role: "user" | "assistant"; content: string }>;
  attachments?: AttachmentPart[];
  // Metadata of the local attachments (name/type/size only — the files stay on
  // this machine), persisted with the user message so its chips survive reloads.
  attachmentsMeta?: Array<{ fileName: string; fileType?: string; fileSize?: number }>;
}

export interface SidecarAgentRunApi {
  activeRun: ActiveSidecarRun | null;
  pendingApproval: SidecarApprovalRequest | null;
  lastError: string | null;
  isBusy: boolean;
  lastFinishedRunId: string | null;
  isRollingBack: boolean;
  rollbackError: string | null;
  sdkSessionId: string | null;

  /**
   * Kicks off a sidecar agent run bound to the given assistant message.
   * Fetches the channel credentials through the server endpoint, then
   * calls sidecarClient.runAgent. Resolves as soon as the sidecar
   * accepts the request — the actual run continues asynchronously and
   * streams back into the assistant message through chatStore.
   */
  startRun: (input: SidecarAgentRunInput) => Promise<void>;

  /**
   * Responds to a pending sidecar approval. Returns the same approval
   * so callers can log / inspect it if needed.
   */
  respondToApproval: (approvalId: string, allow: boolean) => Promise<void>;

  /** Cancels the current sidecar run if any. */
  cancel: () => Promise<void>;

  /** Rolls back the most recently finished sidecar run's checkpoint. */
  rollbackLast: () => Promise<void>;

  /** Clears the last error (e.g. when switching conversations). */
  clearError: () => void;
}

/**
 * Thin hook that wires the sidecar client into the existing chatStore
 * message pipeline. It does NOT know anything about the composer or
 * the task-card renderer; callers pass in the assistant message id
 * they already created and the hook just pipes events back through
 * chatStore.applyStreamEvent (which is the same interface the server
 * runtime uses).
 */
export function useSidecarAgentRun(): SidecarAgentRunApi {
  const [activeRun, setActiveRun] = useState<ActiveSidecarRun | null>(null);
  const [pendingApproval, setPendingApproval] = useState<SidecarApprovalRequest | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [lastFinishedRunId, setLastFinishedRunId] = useState<string | null>(null);
  const [isRollingBack, setIsRollingBack] = useState(false);
  const [rollbackError, setRollbackError] = useState<string | null>(null);
  const [sdkSessionId, setSdkSessionId] = useState<string | null>(null);
  const runRef = useRef<ActiveSidecarRun | null>(null);
  // Guards the one-shot persistence of a run's user+assistant messages. A run
  // ends through exactly one of done / onError, but error events can interleave;
  // this ref ensures syncSidecar (an insert, not an upsert) runs at most once
  // per run so we never duplicate the round. Reset at the start of every run.
  const persistedRef = useRef(false);

  const syncRun = (run: ActiveSidecarRun | null) => {
    if (run === null && runRef.current) {
      // A run just finished; remember its id for rollback.
      setLastFinishedRunId(runRef.current.runId);
    }
    runRef.current = run;
    setActiveRun(run);
  };

  const startRun = async (input: SidecarAgentRunInput): Promise<void> => {
    const sidecar = useSidecarStore.getState();
    const client = sidecar.client;
    if (!client || sidecar.status !== "ready") {
      setLastError("本地运行尚未就绪");
      return;
    }
    if (runRef.current !== null) {
      try {
        await client.cancelRun(runRef.current.runId);
      } catch {}
      syncRun(null);
      setIsBusy(false);
    }

    setIsBusy(true);
    setLastError(null);
    setPendingApproval(null);
    // Starting a new run replaces the rollback target. The previous
    // run's checkpoint still lives on disk but we no longer surface
    // the button — you should roll back before running a new task.
    setLastFinishedRunId(null);
    setRollbackError(null);

    // Fresh persistence guard for this run.
    persistedRef.current = false;

    // Mark this run's message ids so that navigating away and back mid-run keeps
    // the live/streaming copy instead of overwriting it with the (stale) DB row —
    // matters for in-flight edits, which re-use the persisted ids. Cleared once
    // the run persists (server row becomes fresh) in persistOnce.
    const activeRunIds = [
      input.existingUserMessageId,
      input.existingAssistantMessageId,
      input.assistantMessageId,
    ].filter((id): id is string => Boolean(id));
    useChatStore.getState().markMessagesActive(activeRunIds);

    // One-shot persistence of the user message + assistant result. Called from
    // the done path (final text, possibly empty) and from every failure path
    // (error / onError / early returns), so that even a failed or empty-output
    // run keeps the user's message — and its failure state — in the DB. Idempotent
    // via persistedRef; syncSidecar inserts (or, for edits, updates) both rows so
    // it must run at most once.
    const persistOnce = async (assistantContent: string, agentRun: unknown, model: string) => {
      if (persistedRef.current) return;
      persistedRef.current = true;
      try {
        // Only reuse ids that are already persisted (real server ids). Optimistic
        // temp-/draft- ids don't exist server-side, so fall back to insert.
        const isPersistedId = (id?: string) =>
          Boolean(id && !id.startsWith("temp-") && !id.startsWith("draft-"));
        const updateInPlace =
          isPersistedId(input.existingUserMessageId) &&
          isPersistedId(input.existingAssistantMessageId);
        const res = await api.messages.syncSidecar({
          conversationId: input.conversationId,
          userContent: input.displayContent ?? input.prompt,
          assistantContent,
          model,
          agentRun: agentRun ?? undefined,
          attachmentsMeta: input.attachmentsMeta,
          ...(updateInPlace
            ? {
                userMessageId: input.existingUserMessageId,
                assistantMessageId: input.existingAssistantMessageId,
              }
            : {}),
        });
        // Align the optimistic draft ids with the persisted ids so revisiting
        // the conversation doesn't duplicate the round.
        if (res?.userMessageId && res?.assistantMessageId) {
          useChatStore.getState().reconcileSidecarMessageIds({
            conversationId: input.conversationId,
            assistantDraftId: input.assistantMessageId,
            userMessageId: res.userMessageId,
            assistantMessageId: res.assistantMessageId,
          });
        }
      } catch {
        // Best-effort: a persistence failure must not affect the UI.
      } finally {
        // Server row is now fresh (or we tried) — the stale-DB guard is no longer
        // needed for these ids.
        useChatStore.getState().unmarkMessagesActive(activeRunIds);
      }
    };

    // Persist a failed run, preferring the assistant message's current content +
    // failure-state agentRun (applyStreamEvent error sets status "failed"), and
    // falling back to a minimal failure object when the message isn't available.
    const persistFailure = (message: string, model: string) => {
      const msg = useChatStore.getState().findMessageAnywhere(input.assistantMessageId);
      void persistOnce(
        msg?.content || "",
        msg?.agentRun ?? { status: "failed", summary: message, error: message, steps: [] },
        model,
      );
    };

    let credentials: {
      apiKey: string;
      baseUrl: string | null;
      modelId: string;
      protocol: "openai" | "anthropic" | "google";
    };
    try {
      const result = await api.channels.getCredentials(input.channelId);
      credentials = result.credentials;
    } catch (error) {
      setIsBusy(false);
      const message = error instanceof Error ? error.message : "获取凭据失败";
      setLastError(message);
      useChatStore.getState().applyStreamEvent(input.assistantMessageId, {
        type: "error",
        message,
      });
      persistFailure(message, input.modelId);
      return;
    }

    if (credentials.protocol !== "anthropic" && credentials.protocol !== "openai") {
      setIsBusy(false);
      const message = `本地运行暂不支持该协议：${credentials.protocol}`;
      setLastError(message);
      useChatStore.getState().applyStreamEvent(input.assistantMessageId, {
        type: "error",
        message,
      });
      persistFailure(message, input.modelId || credentials.modelId);
      return;
    }

    // Both the Claude Agent SDK (anthropic) and the pi-agent-core "direct"
    // runtime (openai) consume MCP servers, so fetch them for either protocol.
    // Best-effort: a failure here must not block the run. Each enabled server is
    // reshaped into the SDK's format (`{ type, ...config }`), keyed by name.
    let mcpServers: Record<string, Record<string, unknown>> | undefined;
    if (credentials.protocol === "anthropic" || credentials.protocol === "openai") {
      try {
        const { servers } = await api.mcp.listServers();
        const map: Record<string, Record<string, unknown>> = {};
        for (const server of (servers || []) as Array<{
          name: string;
          type: string;
          config: Record<string, unknown> | null;
          isEnabled: boolean;
        }>) {
          if (!server.isEnabled) continue;
          map[server.name] = { type: server.type, ...(server.config || {}) };
        }
        if (Object.keys(map).length > 0) mcpServers = map;
        // Slash-targeted run: keep only the invoked server. If the name no
        // longer matches an enabled server (e.g. it was disabled meanwhile),
        // fall back to the full roster rather than silently dropping MCP.
        const target = input.targetMcpServer?.trim().toLowerCase();
        if (mcpServers && target) {
          const hit = Object.entries(mcpServers).find(([name]) => name.toLowerCase() === target);
          if (hit) mcpServers = { [hit[0]]: hit[1] };
        }
      } catch {
        // MCP is additive; ignore load failures and run without it.
      }
    }

    // Re-sync the workspace to the sidecar before EVERY run (for the agent's cwd
    // and MCP). The sidecar may have restarted and lost it, diverging from the
    // desktop's value. Best-effort — the run continues regardless.
    try {
      await useSidecarStore.getState().ensureWorkspace();
    } catch {
      // ignore; the sidecar keeps whatever workspace it already has
    }

    // Enabled Agent Skills — read IN PLACE from their real folders (Claude-style):
    // the run carries each skill's name/description + absolute folder path;
    // nothing is copied and no workspace is required. Best-effort, never blocks.
    let skillMetas: SkillMeta[] | undefined;
    if (credentials.protocol === "anthropic" || credentials.protocol === "openai") {
      try {
        const resolved = await resolveEnabledSkills();
        if (resolved.length > 0) skillMetas = resolved;
      } catch {
        // Skills are additive; ignore discovery failures and run without.
      }
    }

    let runId: string;
    try {
      runId = await client.runAgent({
        prompt: input.prompt,
        apiKey: credentials.apiKey,
        model: input.modelId || credentials.modelId,
        baseUrl: credentials.baseUrl ?? undefined,
        protocol: credentials.protocol,
        sdkSessionId: input.sdkSessionId ?? sdkSessionId ?? undefined,
        permissionMode: input.permissionMode,
        systemPrompt: input.systemPrompt,
        webSearchEnabled: input.webSearchEnabled,
        tavilyApiKey: input.tavilyApiKey,
        mcpServers,
        skills: skillMetas,
        conversationHistory: input.conversationHistory,
        attachments: input.attachments,
        onSdkSessionId: (sessionId) => {
          setSdkSessionId(sessionId);
        },
        onEvent: (() => {
          return (event: import("../lib/agentTaskStream").AgentTaskStreamEvent) => {
            if (
              event.type === "execution_event" &&
              event.eventType === "final_text" &&
              event.content
            ) {
              useChatStore.getState().applyStreamEvent(input.assistantMessageId, {
                type: "delta",
                content: event.content,
              });
              return;
            }
            if (event.type === "execution_event" && event.eventType === "text" && event.content) {
              useChatStore.getState().applyStreamEvent(input.assistantMessageId, {
                type: "delta",
                content: event.content,
              });
              return;
            }
            if (
              event.type === "execution_event" &&
              event.eventType !== "final_text" &&
              event.eventType !== "text"
            ) {
              useChatStore.getState().applyStreamEvent(input.assistantMessageId, {
                type: "agent_event",
                event: {
                  type: event.eventType ?? "",
                  content: event.content,
                  toolName: event.toolName,
                  toolInput: event.toolInput,
                },
              });
              return;
            }
            if (event.type === "done") {
              useChatStore.getState().applyStreamEvent(input.assistantMessageId, {
                type: "done",
                messageId: input.assistantMessageId,
              });
              const assistantMsg = useChatStore
                .getState()
                .findMessageAnywhere(input.assistantMessageId);
              const assistantContent = assistantMsg?.content || "";
              // Persist even when the assistant produced no text, so an empty-output
              // run still keeps the user's message. Deduped against onError via
              // persistedRef.
              void persistOnce(
                assistantContent,
                assistantMsg?.agentRun ?? undefined,
                input.modelId || credentials.modelId,
              );
              if (credentials.protocol !== "anthropic") {
                setLastFinishedRunId(null);
              }
              syncRun(null);
              setIsBusy(false);
            }
            if (event.type === "error") {
              useChatStore.getState().applyStreamEvent(input.assistantMessageId, {
                type: "error",
                message: event.content || "本地运行出错",
              });
            }
          };
        })(),
        onApproval: (request) => {
          setPendingApproval(request);
        },
        onError: (message) => {
          setLastError(message);
          useChatStore.getState().applyStreamEvent(input.assistantMessageId, {
            type: "error",
            message,
          });
          // Keep the user's message (with the failure state) in the DB even
          // though the run never produced a persistable assistant result.
          persistFailure(message, input.modelId || credentials.modelId);
          syncRun(null);
          setIsBusy(false);
        },
        onDone: () => {
          syncRun(null);
          setIsBusy(false);
        },
      });
    } catch (error) {
      setIsBusy(false);
      const message = error instanceof Error ? error.message : "启动本地运行失败";
      setLastError(message);
      useChatStore.getState().applyStreamEvent(input.assistantMessageId, {
        type: "error",
        message,
      });
      persistFailure(message, input.modelId || credentials.modelId);
      return;
    }

    const nextRun: ActiveSidecarRun = {
      runId,
      messageId: input.assistantMessageId,
      conversationId: input.conversationId,
    };
    syncRun(nextRun);
  };

  const respondToApproval = async (approvalId: string, allow: boolean): Promise<void> => {
    const approval = pendingApproval;
    if (!approval || approval.toolUseId !== approvalId) return;
    const client = useSidecarStore.getState().client;
    if (!client) return;
    try {
      await client.respondApproval(approvalId, allow);
      setPendingApproval(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : "提交审批失败";
      setLastError(message);
    }
  };

  const cancel = async (): Promise<void> => {
    const run = runRef.current;
    if (!run) return;
    const client = useSidecarStore.getState().client;
    if (!client) return;
    try {
      await client.cancelRun(run.runId);
    } catch {
      // ignore
    }
    syncRun(null);
    setIsBusy(false);
  };

  const rollbackLast = async (): Promise<void> => {
    if (!lastFinishedRunId) return;
    const client = useSidecarStore.getState().client;
    if (!client) {
      setRollbackError("本地运行尚未就绪");
      return;
    }
    setIsRollingBack(true);
    setRollbackError(null);
    try {
      await client.rollbackCheckpoint(lastFinishedRunId);
      setLastFinishedRunId(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : "回滚失败";
      setRollbackError(message);
    } finally {
      setIsRollingBack(false);
    }
  };

  return {
    activeRun,
    pendingApproval,
    lastError,
    isBusy,
    lastFinishedRunId,
    isRollingBack,
    rollbackError,
    sdkSessionId,
    startRun,
    respondToApproval,
    cancel,
    rollbackLast,
    clearError: () => setLastError(null),
  };
}
