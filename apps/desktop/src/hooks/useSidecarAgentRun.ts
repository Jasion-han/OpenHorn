import { useRef, useState } from "react";
import { createServerApi } from "../lib/serverApi";
import type { SidecarApprovalRequest } from "../lib/sidecarClient";
import { useChatStore } from "../stores/chatStore";
import { useSidecarStore } from "../stores/sidecarStore";

const api = createServerApi();

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
  sdkSessionId?: string;
  permissionMode?: "default" | "full-access";
  systemPrompt?: string;
  webSearchEnabled?: boolean;
  tavilyApiKey?: string;
  conversationHistory?: Array<{ role: "user" | "assistant"; content: string }>;
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
      setLastError("已有一个本地运行在进行中");
      return;
    }

    setIsBusy(true);
    setLastError(null);
    setPendingApproval(null);
    // Starting a new run replaces the rollback target. The previous
    // run's checkpoint still lives on disk but we no longer surface
    // the button — you should roll back before running a new task.
    setLastFinishedRunId(null);
    setRollbackError(null);

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
      return;
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
        conversationHistory: input.conversationHistory,
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
            if (event.type === "execution_event") {
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
                .messages.find((m) => m.id === input.assistantMessageId);
              const assistantContent = assistantMsg?.content || "";
              if (assistantContent) {
                void api.messages
                  .syncSidecar({
                    conversationId: input.conversationId,
                    userContent: input.prompt,
                    assistantContent,
                    model: input.modelId || credentials.modelId,
                    agentRun: assistantMsg?.agentRun ?? undefined,
                  })
                  .catch(() => {});
              }
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
