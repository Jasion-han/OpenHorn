import type { AttachmentPart, MessageFinishReason } from "shared/types";
import { create } from "zustand";
import { formatChatLabel, getChatLabel } from "../lib/i18n/agent";
import { createServerApi } from "../lib/serverApi";
import type { SidecarApprovalRequest, SidecarClient } from "../lib/sidecarClient";
import { sidecarPersistence } from "../lib/sidecarPersistence";
import {
  type AcpAvailableModel,
  applySidecarEventToChat,
  type RunUsage,
  resolveEnabledMcpServers,
  resolveEnabledSkills,
  type SkillMeta,
} from "../lib/sidecarRunSupport";
import { resolveSidecarSyncIds, resolveStoppedAgentReply } from "../lib/stopTurn";
import { useChatStore } from "../stores/chatStore";
import { resolveProjectRootForConversation } from "../stores/projectStore";
import { useSidecarStore } from "../stores/sidecarStore";
import type { Message } from "../types/chat";
import { claimRunOwnership, createRunPersistGuard, isRunOwner } from "./sidecarRunOwnership";

const api = createServerApi();

export type { AcpAvailableModel };

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
  /**
   * Regenerate only: the reply this run replaces. If the run is stopped before
   * producing anything, this reply is put back and nothing is written — the
   * user asked to stop the new attempt, not to lose the old answer.
   */
  previousReply?: Message;
  /**
   * The user pressed Stop while the caller was still preparing the run. The
   * turn is persisted as stopped (question kept) without contacting the agent.
   */
  stoppedBeforeStart?: boolean;
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
  /** Synchronous ownership check, including preparation before React renders. */
  hasActiveRun: () => boolean;
  lastFinishedRunId: string | null;
  isRollingBack: boolean;
  rollbackError: string | null;
  sdkSessionId: string | null;
  /** Dynamic model list from ACP agent's session config options. */
  acpAvailableModels: AcpAvailableModel[];
  /** True while the ACP preconnect handshake is in progress. */
  acpPreconnecting: boolean;

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

  /**
   * Stops the current run, if any: aborts it in the sidecar and persists the
   * turn as far as it got (reply marked "cancelled"). Resolves once persisted.
   */
  cancel: () => Promise<void>;

  /** Rolls back the most recently finished sidecar run's checkpoint. */
  rollbackLast: () => Promise<void>;

  /** Clears the last error (e.g. when switching conversations). */
  clearError: () => void;

  /**
   * Pre-connects to the ACP agent for the given channel: spawns the process,
   * completes initialize + session/new, and populates `acpAvailableModels` and
   * `sdkSessionId`. Silently degrades on failure — the model list is fetched
   * during the first `startRun` instead.
   */
  preconnect: (channelId: string) => Promise<{
    models: AcpAvailableModel[];
    agentInfo?: { name: string; version: string };
  } | null>;
}

/**
 * Thin hook that wires the sidecar client into the existing chatStore
 * message pipeline. It does NOT know anything about the composer or
 * the task-card renderer; callers pass in the assistant message id
 * they already created and the hook just pipes events back through
 * chatStore.applyStreamEvent (which is the same interface the server
 * runtime uses).
 */
interface AgentRunState {
  activeRun: ActiveSidecarRun | null;
  pendingApproval: SidecarApprovalRequest | null;
  lastError: string | null;
  isBusy: boolean;
  lastFinishedRunId: string | null;
  isRollingBack: boolean;
  rollbackError: string | null;
  sdkSession: { id: string; protocol: string; conversationId: string | null } | null;
  acpAvailableModels: AcpAvailableModel[];
  acpPreconnecting: boolean;
}

// Execution owns these values, rather than a settings/chat route's mount.
// Existing callbacks continue publishing to the current subscriber after a
// remount, including pending approvals and the actual Stop handle.
const useAgentRunState = create<AgentRunState>(() => ({
  activeRun: null,
  pendingApproval: null,
  lastError: null,
  isBusy: false,
  lastFinishedRunId: null,
  isRollingBack: false,
  rollbackError: null,
  sdkSession: null,
  acpAvailableModels: [],
  acpPreconnecting: false,
}));

function stateSetter<K extends keyof AgentRunState>(key: K) {
  return (value: AgentRunState[K]) => {
    useAgentRunState.setState({ [key]: value } as Pick<AgentRunState, K>);
  };
}
const setActiveRun = stateSetter("activeRun");
const setPendingApproval = stateSetter("pendingApproval");
const setLastError = stateSetter("lastError");
const setIsBusy = stateSetter("isBusy");
const setLastFinishedRunId = stateSetter("lastFinishedRunId");
const setIsRollingBack = stateSetter("isRollingBack");
const setRollbackError = stateSetter("rollbackError");
const setSdkSession = stateSetter("sdkSession");
const setAcpAvailableModels = stateSetter("acpAvailableModels");
const setAcpPreconnecting = stateSetter("acpPreconnecting");
const runRef: { current: ActiveSidecarRun | null } = { current: null };
const controlRef: { current: { stop: () => Promise<void> } | null } = { current: null };
const checkpointRunIdsRef = { current: new Set<string>() };

export function useSidecarAgentRun(): SidecarAgentRunApi {
  const {
    activeRun,
    pendingApproval,
    lastError,
    isBusy,
    lastFinishedRunId,
    isRollingBack,
    rollbackError,
    sdkSession,
    acpAvailableModels,
    acpPreconnecting,
  } = useAgentRunState();
  const sdkSessionId = sdkSession?.id ?? null;
  const resumableSessionId = (protocol: string, conversationId: string): string | undefined => {
    // Preconnection can settle during another run's preparation. Read the live
    // provenance, so a protocol/conversation mismatch cannot resume its session.
    const session = useAgentRunState.getState().sdkSession;
    if (!session || session.protocol !== protocol) return undefined;
    if (protocol !== "acp" && session.conversationId !== conversationId) return undefined;
    return session.id;
  };

  const syncRun = (run: ActiveSidecarRun | null) => {
    if (run === null && runRef.current) {
      // A run just finished; remember its id for rollback — but only when the
      // sidecar reported a checkpoint manifest for it (see checkpointRunIdsRef).
      if (checkpointRunIdsRef.current.has(runRef.current.runId)) {
        setLastFinishedRunId(runRef.current.runId);
      }
    }
    runRef.current = run;
    setActiveRun(run);
  };

  const startRun = async (input: SidecarAgentRunInput): Promise<void> => {
    const sidecar = useSidecarStore.getState();
    const client = sidecar.client;
    // Run-ownership guard. Regenerate re-uses the SAME assistant message id:
    // the retry path clears the bubble and calls startRun again while the old
    // run may still be streaming. Stopping the old run (below) is best-effort at
    // the sidecar, so its in-flight events can still arrive — and chatStore
    // appends deltas purely by message id, which would interleave both runs'
    // text into one message. Claiming a fresh token here disowns the previous
    // run; every callback of THIS run checks ownership first and drops itself
    // once superseded (no store writes, no persistence, no busy/active changes).
    const ownerToken = claimRunOwnership([
      input.assistantMessageId,
      input.existingAssistantMessageId,
    ]);
    const ownsMessage = () => isRunOwner(input.assistantMessageId, ownerToken);
    // Set once the user stopped this run. From then on every late event of the
    // run is dropped; the stop path alone decides what is persisted.
    let stopped = false;
    let terminal = false;
    let terminalPersistence: Promise<void> | null = null;
    const isLive = () => !stopped && !terminal && ownsMessage() && controlRef.current === control;
    // Per-run one-shot persistence guard. A run ends through exactly one of
    // done / error / stop, but they can race; syncSidecar must run at most once
    // per run so we never duplicate the round. Lives in this closure — a
    // hook-level ref would be reset by the next run, letting the old run's late
    // done/error persist again.
    const shouldPersist = createRunPersistGuard(input.assistantMessageId, ownerToken);
    let runId: string | null = null;
    let runModel = input.modelId;
    let runProtocol: string | null = null;
    let streamingMessageId = input.assistantMessageId;
    // Token counts for the turn. The SDK reports them once, on its terminal
    // `result` message, so they land here shortly before `done` — captured in
    // the run closure rather than in the store because their only consumer is
    // the persistence call below.
    let runUsage: RunUsage | null = null;

    // Mark this run's message ids so that navigating away and back mid-run keeps
    // the live/streaming copy instead of overwriting it with the (stale) DB row —
    // matters for in-flight edits, which re-use the persisted ids. Cleared once
    // the run persists (server row becomes fresh).
    const activeRunIds = [
      input.existingUserMessageId,
      input.existingAssistantMessageId,
      input.assistantMessageId,
    ].filter((id): id is string => Boolean(id));

    // One-shot persistence of the user message + assistant result. Called from
    // the done path, the stop path and every failure path, so that a failed,
    // stopped or empty-output run keeps the user's message — and its end state —
    // in the DB. Idempotent via shouldPersist, which also blocks a disowned run
    // (regenerate started a newer run for this message) from overwriting the
    // new run's result.
    const persistOnce = async (
      assistantContent: string,
      agentRun: unknown,
      model: string,
      finishReason?: MessageFinishReason,
    ) => {
      if (!shouldPersist()) return;
      let stampId = input.assistantMessageId;
      let savedUserId: string | undefined;
      try {
        const save = sidecarPersistence.save(
          input.assistantMessageId,
          {
            conversationId: input.conversationId,
            userContent: input.displayContent ?? input.prompt,
            assistantContent,
            model,
            agentRun: agentRun ?? undefined,
            usage: runUsage ?? undefined,
            finishReason,
            attachmentsMeta: input.attachmentsMeta,
            ...resolveSidecarSyncIds(input),
          },
          () => ownsMessage() && controlRef.current === control,
        );
        if (!save) return;
        stampId = save.assistantMessageId;
        savedUserId = save.userMessageId;
        streamingMessageId = stampId;
        await save.completion;
      } finally {
        if (ownsMessage() && controlRef.current === control) {
          // Run activity ends independently of saving. Failed results retain their
          // own unsaved snapshots until a confirmed, matching save succeeds.
          useChatStore
            .getState()
            .unmarkMessagesActive([
              ...activeRunIds,
              stampId,
              ...(savedUserId ? [savedUserId] : []),
            ]);
          useChatStore.getState().updateMessage(stampId, {
            updatedAt: new Date(),
            ...(runUsage ? { usage: runUsage } : {}),
          });
        }
      }
    };

    // Persist a failed run, preferring the assistant message's current content +
    // failure-state agentRun (applyStreamEvent error sets status "failed"), and
    // falling back to a minimal failure object when the message isn't available.
    const persistFailure = (message: string, model: string) => {
      // A disowned run must not read the (already re-cleared) message or persist.
      if (!ownsMessage()) return;
      const msg = useChatStore.getState().findMessageAnywhere(input.assistantMessageId);
      terminal = true;
      // The failure itself is shown globally; it is not new output that should
      // replace a retry's preceding answer when no text or steps were produced.
      const outcome = resolveStoppedAgentReply({
        current: msg?.agentRun ? { ...msg, agentRun: { ...msg.agentRun, error: undefined } } : msg,
        previousReply: input.previousReply,
      });
      if (outcome.kind === "restore") {
        shouldPersist();
        const { id: _id, conversationId: _conversationId, ...previous } = outcome.reply;
        useChatStore.getState().updateMessage(input.assistantMessageId, previous);
        useChatStore.getState().unmarkMessagesActive(activeRunIds);
        terminalPersistence = Promise.resolve().finally(finishRun);
        return;
      }
      terminalPersistence = persistOnce(
        msg?.content || "",
        msg?.agentRun ?? { status: "failed", summary: message, error: message, steps: [] },
        model,
      ).finally(finishRun);
    };

    let stopping: Promise<void> | null = null;
    const control = { stop: () => (stopping ??= stopRun()) };
    // Releases this run's hold on the hook's busy/active state. Only the run that
    // currently holds the control may clear it — a stopped predecessor finishing
    // late must not flip a newer run's state.
    const finishRun = () => {
      if (controlRef.current !== control) return;
      controlRef.current = null;
      setPendingApproval(null);
      useChatStore.getState().completeStreamingMessage(streamingMessageId);
      syncRun(null);
      setIsBusy(false);
    };

    // Stop = stop generating, not "undo this turn": abort the sidecar run, mark
    // the reply "cancelled" (steps kept) and persist the round as far as it got.
    // A regenerate stopped before producing anything restores the reply it
    // replaced instead (see resolveStoppedAgentReply).
    const stopRun = async (): Promise<void> => {
      if (terminalPersistence) {
        await terminalPersistence;
        return;
      }
      const owned = ownsMessage();
      stopped = true;
      if (controlRef.current === control) setPendingApproval(null);
      try {
        if (runId && client) {
          try {
            await client.cancelRun(runId);
          } catch {
            // The run may already have ended in the sidecar.
          }
        }
        if (!owned) return;
        const store = useChatStore.getState();
        const outcome = resolveStoppedAgentReply({
          current: store.findMessageAnywhere(input.assistantMessageId),
          previousReply: input.previousReply,
        });
        if (outcome.kind === "restore") {
          shouldPersist();
          const { id: _id, conversationId: _conversationId, ...previous } = outcome.reply;
          store.updateMessage(input.assistantMessageId, previous);
          store.unmarkMessagesActive(activeRunIds);
          return;
        }
        store.updateMessage(input.assistantMessageId, {
          agentRun: outcome.agentRun,
          content: outcome.assistantContent,
          finishReason: "stopped",
        });
        await persistOnce(outcome.assistantContent, outcome.agentRun, runModel, "stopped");
      } finally {
        finishRun();
      }
    };

    // Both terminal callbacks converge here. The transport can deliver onDone
    // before onEvent(done); either order must persist and complete exactly once.
    const completeRun = () => {
      if (!isLive()) return;
      useChatStore.getState().applyStreamEvent(input.assistantMessageId, {
        type: "done",
        messageId: input.assistantMessageId,
      });
      terminal = true;
      const message = useChatStore.getState().findMessageAnywhere(input.assistantMessageId);
      terminalPersistence = persistOnce(
        message?.content || "",
        message?.agentRun,
        runModel,
      ).finally(finishRun);
      if (runProtocol !== "anthropic" && runProtocol !== "acp") setLastFinishedRunId(null);
    };

    // Install before any await so Stop reaches a run that is still being set up.
    const previousControl = controlRef.current;
    controlRef.current = control;
    if (previousControl) {
      // One run at a time: a new turn stops the previous one, which keeps (and
      // persists) whatever it produced.
      await previousControl.stop();
      if (runRef.current) syncRun(null);
      // Stopped while waiting for the previous run: the stop path already
      // persisted this turn — don't mark the hook busy again.
      if (stopped) return;
    }

    setIsBusy(true);
    setLastError(null);
    setPendingApproval(null);
    // Starting a new run replaces the rollback target. The previous
    // run's checkpoint still lives on disk but we no longer surface
    // the button — you should roll back before running a new task.
    setLastFinishedRunId(null);
    setRollbackError(null);
    useChatStore.getState().markMessagesActive(activeRunIds);

    if (input.stoppedBeforeStart) {
      // Stop arrived while the caller was preparing the run: keep the question,
      // never start the agent.
      await stopRun();
      return;
    }

    if (!client || sidecar.status !== "ready") {
      const message = getChatLabel("chat.error.sidecarNotReady");
      setLastError(message);
      useChatStore.getState().applyStreamEvent(input.assistantMessageId, {
        type: "error",
        message,
      });
      persistFailure(message, input.modelId);
      return;
    }

    let credentials: {
      apiKey: string;
      baseUrl: string | null;
      modelId: string;
      contextWindow?: number | null;
      protocol: "openai" | "anthropic" | "google" | "acp";
    };
    try {
      const result = await api.channels.getCredentials(input.channelId, input.modelId);
      credentials = result.credentials;
      if (!isLive()) return;
    } catch (error) {
      // A newer run may have claimed this message (or the user stopped this
      // one) while we were awaiting — that path owns the outcome now.
      if (!isLive()) return;
      const message = error instanceof Error ? error.message : "获取凭据失败";
      setLastError(message);
      useChatStore.getState().applyStreamEvent(input.assistantMessageId, {
        type: "error",
        message,
      });
      persistFailure(message, input.modelId);
      return;
    }
    runModel = input.modelId || credentials.modelId;
    runProtocol = credentials.protocol;

    if (
      credentials.protocol !== "anthropic" &&
      credentials.protocol !== "openai" &&
      credentials.protocol !== "acp"
    ) {
      // Same as above: skip entirely if a newer run took over during the await.
      if (!isLive()) return;
      const message = `本地运行暂不支持该协议：${credentials.protocol}`;
      setLastError(message);
      useChatStore.getState().applyStreamEvent(input.assistantMessageId, {
        type: "error",
        message,
      });
      persistFailure(message, input.modelId || credentials.modelId);
      return;
    }

    // ACP channels carry the local agent launch config JSON-encoded in the
    // apiKey slot (encrypted at rest server-side). Parse it here; a broken
    // config fails the run with a actionable message instead of a spawn error.
    let acpAgent: { command: string; args?: string[]; env?: Record<string, string> } | undefined;
    if (credentials.protocol === "acp") {
      try {
        const parsed = JSON.parse(credentials.apiKey) as {
          command?: string;
          args?: string[];
          env?: Record<string, string>;
        };
        if (!parsed.command || typeof parsed.command !== "string") {
          throw new Error("missing command");
        }
        acpAgent = { command: parsed.command, args: parsed.args, env: parsed.env };
      } catch {
        if (!isLive()) return;
        const message = "ACP 渠道配置无效：缺少 agent 启动命令，请在渠道设置中重新配置";
        setLastError(message);
        useChatStore.getState().applyStreamEvent(input.assistantMessageId, {
          type: "error",
          message,
        });
        persistFailure(message, input.modelId || credentials.modelId);
        return;
      }
    }

    // Both the Claude Agent SDK (anthropic) and the pi-agent-core "direct"
    // runtime (openai) consume MCP servers, so fetch them for either protocol.
    // Best-effort: a failure here must not block the run. Each enabled server is
    // reshaped into the SDK's format (keyed by name) with its transport type
    // normalized to stdio/sse/http — see normalizeMcpServerConfig.
    let mcpServers: Record<string, Record<string, unknown>> | undefined;
    // ACP agents also consume MCP servers (passed through session/new).
    if (
      credentials.protocol === "anthropic" ||
      credentials.protocol === "openai" ||
      credentials.protocol === "acp"
    ) {
      try {
        // Slash-targeted run: keep only the invoked server (falls back to the
        // full roster when the name no longer matches an enabled server).
        mcpServers = await resolveEnabledMcpServers(api, input.targetMcpServer);
      } catch {
        // MCP is additive; ignore load failures and run without it.
      }
    }

    if (!isLive()) return;
    // Re-sync the workspace to the sidecar before EVERY run (for the agent's cwd
    // and MCP). The sidecar may have restarted and lost it, diverging from the
    // desktop's value. A conversation filed under a sidebar project runs in that
    // project's folder. A failed resolution must refuse the run; falling back
    // to connection-global cwd could execute it in another turn's directory.
    const projectRoot = resolveProjectRootForConversation(
      useChatStore.getState().conversations.find((c) => c.id === input.conversationId),
    );
    let workspaceRoot: string | null = null;
    try {
      workspaceRoot = await useSidecarStore.getState().ensureWorkspace(projectRoot);
    } catch {
      // The failure path below refuses a run without its own resolved root.
    }
    if (!isLive()) return;
    if (!workspaceRoot) {
      const message = projectRoot
        ? formatChatLabel("chat.run.projectRootUnavailable", { root: projectRoot })
        : getChatLabel("chat.run.workspaceUnavailable");
      setLastError(message);
      useChatStore.getState().applyStreamEvent(input.assistantMessageId, {
        type: "error",
        message,
      });
      persistFailure(message, input.modelId || credentials.modelId);
      return;
    }
    if (!isLive()) return;

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

    // Stopped (or superseded) during setup: the stop path already persisted the
    // turn, so the agent is never started.
    if (!isLive()) return;

    let acceptedRunId: string;
    try {
      acceptedRunId = await client.runAgent({
        prompt: input.prompt,
        workspaceRoot,
        // The acp config was already parsed into acpAgent — don't resend the
        // raw JSON in the apiKey slot.
        apiKey: credentials.protocol === "acp" ? "" : credentials.apiKey,
        model: input.modelId || credentials.modelId,
        contextWindow: credentials.contextWindow,
        baseUrl: credentials.baseUrl ?? undefined,
        protocol: credentials.protocol,
        acpAgent,
        sdkSessionId:
          input.sdkSessionId ?? resumableSessionId(credentials.protocol, input.conversationId),
        permissionMode: input.permissionMode,
        systemPrompt: input.systemPrompt,
        webSearchEnabled: input.webSearchEnabled,
        tavilyApiKey: input.tavilyApiKey,
        mcpServers,
        skills: skillMetas,
        conversationHistory: input.conversationHistory,
        attachments: input.attachments,
        tokenBudgetPerRun: undefined,
        onSdkSessionId: (sessionId) => {
          if (!isLive()) return;
          setSdkSession({
            id: sessionId,
            protocol: credentials.protocol,
            conversationId: input.conversationId,
          });
        },
        onCheckpointReady: (ckptRunId) => {
          // Keyed by runId, so a superseded run's late signal can't taint the
          // new run — no ownership guard needed.
          checkpointRunIdsRef.current.add(ckptRunId);
        },
        onEvent: (() => {
          return (event: import("../lib/agentTaskStream").AgentTaskStreamEvent) => {
            // Ownership / stop guard: once a newer run (regenerate) claims this
            // message, or the user stopped this run, every late event from it —
            // delta, done, error — is dropped wholesale, so two runs' text can't
            // interleave and a stopped reply stays exactly as it was persisted.
            if (!isLive()) return;
            // Text / tool steps / usage / failure state are projected onto the
            // assistant message by the shared bridge (same code path as a
            // scheduled run); only the side data comes back here.
            if (event.type === "done") {
              completeRun();
              return;
            }
            const outcome = applySidecarEventToChat(input.assistantMessageId, event);
            if (outcome.kind === "acp_models") {
              // ACP dynamic model list — update the hook state so the model
              // picker can show agent-provided models instead of the channel list.
              setAcpAvailableModels(outcome.models);
              return;
            }
            if (outcome.kind === "usage") {
              runUsage = outcome.usage;
              return;
            }
            if (outcome.kind === "error") {
              setLastError(outcome.message);
              persistFailure(outcome.message, runModel);
            }
          };
        })(),
        onApproval: (request) => {
          if (!isLive()) return;
          setPendingApproval(request);
        },
        onError: (message) => {
          // Ownership guard (see onEvent): a superseded run's failure must not
          // pollute the new run's message, UI state, or persistence.
          if (!isLive()) return;
          setLastError(message);
          useChatStore.getState().applyStreamEvent(input.assistantMessageId, {
            type: "error",
            message,
          });
          // Keep the user's message (with the failure state) in the DB even
          // though the run never produced a persistable assistant result.
          persistFailure(message, input.modelId || credentials.modelId);
        },
        onDone: () => {
          // Ownership guard (see onEvent): the old run's done — e.g. after the
          // stop — must not clear the NEW run's busy/active state.
          completeRun();
        },
      });
    } catch (error) {
      // Ownership guard (see above): don't clobber a newer run's state.
      if (!isLive()) return;
      const message = error instanceof Error ? error.message : "启动本地运行失败";
      setLastError(message);
      useChatStore.getState().applyStreamEvent(input.assistantMessageId, {
        type: "error",
        message,
      });
      persistFailure(message, input.modelId || credentials.modelId);
      return;
    }

    runId = acceptedRunId;
    if (!isLive()) {
      // Stopped, or a newer run claimed this message, while the sidecar was
      // accepting this one. The stop path had no run id to cancel yet — cancel
      // the now-orphaned run here (its events are dropped by the guards anyway,
      // but there is no point letting it keep executing).
      try {
        await client.cancelRun(acceptedRunId);
      } catch {}
      return;
    }
    // The run may already have ended (its done can arrive right after the
    // sidecar accepted it); never register a finished run as active.
    if (controlRef.current !== control) return;

    const nextRun: ActiveSidecarRun = {
      runId: acceptedRunId,
      messageId: input.assistantMessageId,
      conversationId: input.conversationId,
    };
    syncRun(nextRun);
  };

  const respondToApproval = async (approvalId: string, allow: boolean): Promise<void> => {
    const approval = useAgentRunState.getState().pendingApproval;
    if (!approval || approval.toolUseId !== approvalId) return;
    const control = controlRef.current;
    const client = useSidecarStore.getState().client;
    if (!client) return;
    try {
      await client.respondApproval(approvalId, allow);
      if (
        controlRef.current === control &&
        useAgentRunState.getState().pendingApproval?.toolUseId === approvalId
      ) {
        setPendingApproval(null);
      }
    } catch (error) {
      if (controlRef.current !== control) return;
      const message = error instanceof Error ? error.message : "提交审批失败";
      setLastError(message);
    }
  };

  const cancel = async (): Promise<void> => {
    await controlRef.current?.stop();
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

  const preconnect = async (
    channelId: string,
  ): Promise<{
    models: AcpAvailableModel[];
    agentInfo?: { name: string; version: string };
  } | null> => {
    // Wait for sidecar to become ready (up to 10 seconds). On Tauri startup
    // the sidecar may still be in "starting"/"connecting" state when the user
    // clicks an ACP channel, so an immediate bail-out would cause preconnect
    // to never trigger.
    const sidecar = useSidecarStore.getState();
    let client: SidecarClient | null = sidecar.client;
    if (!client || sidecar.status !== "ready") {
      client = await new Promise<SidecarClient | null>((resolve) => {
        const unsub = useSidecarStore.subscribe((state) => {
          if (state.status === "ready" && state.client) {
            unsub();
            resolve(state.client);
          }
          if (state.status === "error" || state.status === "unsupported") {
            unsub();
            resolve(null);
          }
        });
        // Check the current value — subscribe may register after the state
        // already transitioned to ready.
        const current = useSidecarStore.getState();
        if (current.status === "ready" && current.client) {
          unsub();
          resolve(current.client);
        }
        if (current.status === "error" || current.status === "unsupported") {
          unsub();
          resolve(null);
        }
        // Timeout: give up after 10 seconds and degrade silently.
        setTimeout(() => {
          unsub();
          resolve(null);
        }, 10_000);
      });
      if (!client) {
        console.error("[acp-preconnect] sidecar not ready after wait");
        return null;
      }
    }

    setAcpPreconnecting(true);
    try {
      const credResult = await api.channels.getCredentials(channelId);
      const credentials = credResult.credentials;
      if (credentials.protocol !== "acp") {
        console.error("[acp-preconnect] not acp protocol:", credentials.protocol);
        return null;
      }

      let acpAgent: { command: string; args?: string[]; env?: Record<string, string> };
      try {
        const parsed = JSON.parse(credentials.apiKey) as {
          command?: string;
          args?: string[];
          env?: Record<string, string>;
        };
        if (!parsed.command || typeof parsed.command !== "string") {
          console.error("[acp-preconnect] missing or invalid command in config:", parsed);
          return null;
        }
        acpAgent = { command: parsed.command, args: parsed.args, env: parsed.env };
      } catch (err) {
        console.error("[acp-preconnect] config parse failed", err);
        return null;
      }

      // Fetch enabled MCP servers — same as startRun.
      let mcpServers: Record<string, Record<string, unknown>> | undefined;
      try {
        mcpServers = await resolveEnabledMcpServers(api);
      } catch {
        // MCP is additive; ignore load failures.
      }

      // Ensure the workspace is set so the sidecar has a cwd (the project's
      // folder for a conversation filed under a sidebar project).
      try {
        await useSidecarStore
          .getState()
          .ensureWorkspace(
            resolveProjectRootForConversation(useChatStore.getState().currentConversation),
          );
      } catch {
        // ignore
      }

      const result = await client.preconnectAcp({ acpAgent, mcpServers });

      if (result.sessionId) {
        setSdkSession({
          id: result.sessionId,
          protocol: "acp",
          conversationId: useChatStore.getState().currentConversation?.id ?? null,
        });
      }
      if (result.models && result.models.length > 0) {
        setAcpAvailableModels(result.models);
      }
      return { models: result.models || [], agentInfo: result.agentInfo };
    } catch (err) {
      console.error("[acp-preconnect] failed:", err);
      return null;
    } finally {
      setAcpPreconnecting(false);
    }
  };

  return {
    activeRun,
    pendingApproval,
    lastError,
    isBusy,
    hasActiveRun: () => controlRef.current !== null,
    lastFinishedRunId,
    isRollingBack,
    rollbackError,
    sdkSessionId,
    acpAvailableModels,
    acpPreconnecting,
    startRun,
    respondToApproval,
    cancel,
    rollbackLast,
    clearError: () => setLastError(null),
    preconnect,
  };
}
