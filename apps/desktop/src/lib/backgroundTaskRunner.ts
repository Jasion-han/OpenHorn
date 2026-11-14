import { missingRecipeCapabilities, renderRecipePrompt, validateRecipeSpec } from "shared/recipes";
import type { ModelContextMetadata, ScheduledTask, ScheduledTaskRun } from "shared/types";
import { claimRunOwnership, createRunPersistGuard, isRunOwner } from "../hooks/sidecarRunOwnership";
import { useChatStore } from "../stores/chatStore";
import { resolveProjectRootForConversation, useProjectStore } from "../stores/projectStore";
import { useScheduledTaskStore } from "../stores/scheduledTaskStore";
import { useSidecarStore } from "../stores/sidecarStore";
import type { Message } from "../types/chat";
import { getDesktopBackendBase } from "./backendBase";
import { buildConversationHistory } from "./conversationHistory";
import { getEffectiveModelForConversation } from "./effectiveModel";
import { getChatLabel, getScheduledTaskLabel } from "./i18n/agent";
import { notifyError, notifySuccess } from "./notify";
import { createScheduledRunLease } from "./scheduledRunLease";
import { createServerApi, fetchWithBackendStatus } from "./serverApi";
import type { SidecarClient } from "./sidecarClient";
import { sidecarPersistence } from "./sidecarPersistence";
import {
  applySidecarEventToChat,
  type RunUsage,
  resolveEnabledMcpServers,
  resolveEnabledSkills,
  resolveRunSettings,
} from "./sidecarRunSupport";

/**
 * Executes scheduled tasks in the background, exactly like a typed message.
 *
 * The server is the clock: at `nextRunAt` it creates the task's conversation
 * and a `pending` run. This module claims that run and drives the same turn
 * the composer would — same credentials / MCP / skills / workspace / system
 * prompt / Tavily inputs, the same event → chatStore projection (so opening the
 * conversation mid-run shows it streaming), the same `sync-sidecar`
 * persistence — then reports completed / failed on the run.
 *
 * Timing: a timer is armed to the earliest `nextRunAt` (landing just after the
 * server's own +1s settle), and the run list is checked there with short
 * retries, so pickup lands ~1–2s after the due time instead of waiting for a
 * poll. A slow fallback poll covers anything the timer cannot know about
 * (tasks created from another client, clock corrections).
 */

const api = createServerApi();

// Server timer lands 1s past the due time; land after it.
const LANDING_MS = 1_500;
const PICKUP_RETRY_MS = 2_000;
const PICKUP_RETRIES = 5;
const FALLBACK_POLL_MS = 60_000;
// setTimeout caps at 2^31-1 ms; re-arm hourly rather than trusting long timers.
const MAX_TIMER_MS = 3_600_000;
// A due time this far in the past that still has no run means the server has
// not fired yet (down, or its clock behind). Leave it to the fallback poll
// rather than re-arming a timer that would fire immediately, over and over.
const STALE_DUE_MS = 2 * 60_000;
const SIDECAR_WAIT_MS = 60_000;
// Unattended runs have nobody to press Stop; a turn still going after this is
// cancelled and recorded as failed so the run list cannot show it "running"
// for ever.
const RUN_TIMEOUT_MS = 30 * 60_000;
const RESULT_SUMMARY_CHARS = 300;

let initialized = false;
let dueTimer: ReturnType<typeof setTimeout> | null = null;
let sweepInFlight: Promise<boolean> | null = null;
const MAX_CONCURRENT_RUNS = 2;
const handledRunIds = new Set<string>();
const claimTokens = new Map<string, string>();
type RunLease = {
  ownerToken: string;
  backendBase: string;
  lease: ReturnType<typeof createScheduledRunLease>;
};
const runLeases = new Map<string, RunLease>();

export function startBackgroundTaskRunner() {
  if (initialized) return;
  initialized = true;

  // Any change to the task list (create / edit / toggle / delete / reload after a
  // run) can move the earliest due time: re-arm from the fresh list.
  useScheduledTaskStore.subscribe((state, prev) => {
    if (state.tasks !== prev.tasks) armDueTimer(state.tasks);
  });
  // The task list itself is part of the unified server load (lib/serverState),
  // which may already have finished by the time the sidecar platform resolves.
  armDueTimer(useScheduledTaskStore.getState().tasks);

  void sweepPendingRuns();
  setInterval(() => void sweepPendingRuns(), FALLBACK_POLL_MS);
}

/** Startup/reconnect and manual enqueue use the same pending-run queue. */
export async function syncScheduledRunsAfterLoad(): Promise<void> {
  if (!initialized) return;
  await sweepPendingRuns();
}

export function wakeBackgroundTaskRunner(): void {
  if (initialized) void sweepPendingRuns();
}

function armDueTimer(tasks: ScheduledTask[]) {
  if (dueTimer) {
    clearTimeout(dueTimer);
    dueTimer = null;
  }
  const now = Date.now();
  let earliest: number | null = null;
  for (const task of tasks) {
    if (!task.enabled || !task.nextRunAt) continue;
    const at = task.nextRunAt.getTime();
    if (at < now - STALE_DUE_MS) continue;
    if (earliest === null || at < earliest) earliest = at;
  }
  if (earliest === null) return;

  const untilDue = earliest - now;
  if (untilDue > MAX_TIMER_MS) {
    dueTimer = setTimeout(() => {
      dueTimer = null;
      armDueTimer(useScheduledTaskStore.getState().tasks);
    }, MAX_TIMER_MS);
    return;
  }
  dueTimer = setTimeout(() => {
    dueTimer = null;
    void pickUpDueRuns();
  }, Math.max(untilDue, 0) + LANDING_MS);
}

/**
 * Fired at a due time. The server's run row may land a moment after ours, so
 * retry briefly; then reload the tasks (their nextRunAt advanced) which re-arms
 * the timer for the next due time through the store subscription.
 */
async function pickUpDueRuns() {
  for (let attempt = 0; attempt <= PICKUP_RETRIES; attempt++) {
    if (await sweepPendingRuns()) break;
    await sleep(PICKUP_RETRY_MS);
  }
  await useScheduledTaskStore.getState().loadTasks();
}

/**
 * Returns true when at least one new pending run was taken. Concurrent callers
 * (the due timer, its retries and the fallback interval can overlap) share one
 * pass instead of stacking requests.
 */
function sweepPendingRuns(): Promise<boolean> {
  if (sweepInFlight) return sweepInFlight;
  sweepInFlight = (async () => {
    let runs: ScheduledTaskRun[];
    try {
      const response = await fetchWithBackendStatus(
        `${getDesktopBackendBase()}/scheduled-tasks/runs/pending`,
      );
      if (!response.ok) return false;
      const data = (await response.json()) as { runs: ScheduledTaskRun[] };
      runs = data.runs.map((run) => ({ ...run, startedAt: new Date(run.startedAt) }));
    } catch {
      return false;
    }
    let picked = false;
    for (const run of runs) {
      if (handledRunIds.size >= MAX_CONCURRENT_RUNS) break;
      if (run.status !== "pending" || handledRunIds.has(run.id)) continue;
      handledRunIds.add(run.id);
      picked = true;
      void handlePendingRun(run);
    }
    return picked;
  })().finally(() => {
    sweepInFlight = null;
  });
  return sweepInFlight;
}

async function handlePendingRun(run: ScheduledTaskRun) {
  const claim = await claimRun(run.id);
  if (claim !== "claimed") {
    handledRunIds.delete(run.id);
    return;
  }
  try {
    let task = useScheduledTaskStore.getState().tasks.find((t) => t.id === run.taskId);
    if (!task) {
      await useScheduledTaskStore.getState().loadTasks();
      task = useScheduledTaskStore.getState().tasks.find((t) => t.id === run.taskId);
    }
    if (!task) {
      await completeRun(run.id, {
        status: "failed",
        error: getScheduledTaskLabel("scheduledTask.run.startFailed"),
      });
      void useScheduledTaskStore.getState().loadRuns();
      return;
    }

    await executeRun(run, task);
  } catch (error) {
    await completeRun(run.id, {
      status: "failed",
      error:
        error instanceof Error
          ? error.message
          : getScheduledTaskLabel("scheduledTask.run.startFailed"),
    });
  } finally {
    runLeases.get(run.id)?.lease.stop();
    runLeases.delete(run.id);
    claimTokens.delete(run.id);
    handledRunIds.delete(run.id);
    const scheduled = useScheduledTaskStore.getState();
    void scheduled.loadRuns();
    void scheduled.loadTasks();
    // The task's conversation now has content and a fresh updatedAt; the
    // sidebar reads both from the conversation list.
    void useChatStore.getState().loadConversations();
    queueMicrotask(() => void sweepPendingRuns());
  }
}

async function executeRun(run: ScheduledTaskRun, task: ScheduledTask) {
  const executionLease = runLeases.get(run.id);
  if (!executionLease || !executionLease.lease.isLive()) return;
  const conversationId = run.conversationId;
  const failEarly = async (error: string) => {
    await completeRun(run.id, { status: "failed", error });
    notifyOutcome(task, { ok: false, error });
  };
  if (!conversationId) {
    await failEarly(getScheduledTaskLabel("scheduledTask.run.conversationMissing"));
    return;
  }
  const client = await waitForSidecar();
  if (!client) {
    await failEarly(getScheduledTaskLabel("scheduledTask.run.sidecarNotReady"));
    return;
  }

  // Same resolution as the composer: the conversation's channel/model override,
  // else the global default — validated against the loaded channel list.
  const chat = useChatStore.getState();
  if (chat.channels.length === 0) {
    await chat.loadChannels().catch(() => {});
  }
  let conversation = useChatStore
    .getState()
    .conversations.find((item) => item.id === conversationId);
  if (!conversation) {
    await useChatStore
      .getState()
      .loadConversations()
      .catch(() => {});
    conversation = useChatStore.getState().conversations.find((item) => item.id === conversationId);
  }
  if (!conversation) {
    await failEarly(getScheduledTaskLabel("scheduledTask.run.conversationMissing"));
    return;
  }
  let recipeSpec: ReturnType<typeof validateRecipeSpec> | undefined;
  if (task.recipeSnapshot) {
    try {
      const response = await fetchWithBackendStatus(
        `${executionLease.backendBase}/conversations/${conversationId}`,
      );
      if (!response.ok) throw new Error("Recipe conversation unavailable");
      const { conversation: fresh } = (await response.json()) as {
        conversation: {
          id: string;
          projectId?: string | null;
          channelId?: string | null;
          modelId?: string | null;
          forceWebSearch?: boolean | null;
        };
      };
      if (!fresh || fresh.id !== conversationId) throw new Error("Recipe conversation unavailable");
      conversation = {
        ...conversation,
        projectId: fresh.projectId,
        channelId: fresh.channelId ?? undefined,
        modelId: fresh.modelId ?? undefined,
        forceWebSearch: fresh.forceWebSearch ?? conversation.forceWebSearch ?? true,
      };
      recipeSpec = validateRecipeSpec(task.recipeSnapshot.spec);
      const rendered = renderRecipePrompt(recipeSpec, task.recipeSnapshot.values);
      if (
        rendered.prompt !== task.prompt ||
        task.recipeSnapshot.renderedPrompt !== task.prompt ||
        (recipeSpec.projectId ?? null) !== (task.projectId ?? null) ||
        (conversation.projectId ?? null) !== (task.projectId ?? null) ||
        (recipeSpec.channelId ?? null) !== (task.channelId ?? null) ||
        (recipeSpec.modelId ?? null) !== (task.modelId ?? null) ||
        (recipeSpec.channelId &&
          (conversation.channelId !== recipeSpec.channelId ||
            conversation.modelId !== recipeSpec.modelId)) ||
        (recipeSpec.requirements.workspace && !task.projectId)
      )
        throw new Error("Invalid recipe snapshot binding");
    } catch {
      await failEarly(getScheduledTaskLabel("scheduledTask.run.recipeSnapshotInvalid"));
      return;
    }
  }
  const effectiveModel = getEffectiveModelForConversation(
    useChatStore.getState().channels,
    conversation,
  );
  if (!effectiveModel.ok) {
    await failEarly(effectiveModel.reason);
    return;
  }
  const { channelId, modelId } = effectiveModel;
  const forceWebSearch = conversation.forceWebSearch ?? true;

  // Optimistic round, exactly as handleSend seeds it — but into whichever
  // conversation the task owns, without touching the one on screen.
  const turnId = crypto.randomUUID();
  const userMessageId = `temp-${turnId}`;
  const assistantMessageId = `temp-assistant-${turnId}`;
  const drafts: Message[] = [
    {
      id: userMessageId,
      conversationId,
      role: "user",
      content: task.prompt,
      mode: "agent",
      createdAt: new Date(),
    },
    {
      id: assistantMessageId,
      conversationId,
      role: "assistant",
      content: "",
      mode: "agent",
      agentRun: { status: "partial", summary: "Thinking", steps: [] },
      createdAt: new Date(),
    },
  ];
  useChatStore.getState().seedConversationMessages(conversationId, drafts);
  useChatStore.getState().markMessagesActive([userMessageId, assistantMessageId]);
  const ownerToken = claimRunOwnership([assistantMessageId]);
  const ownsMessage = () =>
    executionLease.lease.isLive() && isRunOwner(assistantMessageId, ownerToken);
  const shouldPersist = createRunPersistGuard(assistantMessageId, ownerToken);

  let runUsage: RunUsage | null = null;

  // One-shot persistence through the same endpoint a typed turn uses, followed
  // by the same draft → server id reconciliation; a failed run keeps the user's
  // message and its failure state in the DB just like the composer path.
  const persistOnce = async (
    assistantContent: string,
    agentRun: unknown,
    model: string,
  ): Promise<boolean> => {
    if (!(await executionLease.lease.renew()) || !shouldPersist()) return false;
    let stampId = assistantMessageId;
    let savedUserId: string | undefined;
    try {
      const save = sidecarPersistence.save(
        assistantMessageId,
        {
          conversationId,
          userContent: task.prompt,
          assistantContent,
          model,
          agentRun: agentRun ?? undefined,
          usage: runUsage ?? undefined,
        },
        ownsMessage,
      );
      if (!save) return false;
      stampId = save.assistantMessageId;
      savedUserId = save.userMessageId;
      return (await save.completion) === true;
    } finally {
      useChatStore
        .getState()
        .unmarkMessagesActive([
          userMessageId,
          assistantMessageId,
          stampId,
          ...(savedUserId ? [savedUserId] : []),
        ]);
      useChatStore.getState().updateMessage(stampId, {
        updatedAt: new Date(),
        ...(runUsage ? { usage: runUsage } : {}),
      });
    }
  };

  const failRun = async (message: string, model: string) => {
    if (!isRunOwner(assistantMessageId, ownerToken)) return;
    useChatStore.getState().applyStreamEvent(assistantMessageId, { type: "error", message });
    const msg = useChatStore.getState().findMessageAnywhere(assistantMessageId);
    await persistOnce(
      msg?.content || "",
      msg?.agentRun ?? { status: "failed", summary: message, error: message, steps: [] },
      model,
    );
    await completeRun(run.id, { status: "failed", error: message });
    notifyOutcome(task, { ok: false, error: message });
  };

  let resolvedModel = modelId;
  try {
    let credentials: {
      apiKey: string;
      baseUrl: string | null;
      modelId: string;
      contextWindow?: number | null;
      contextMetadata?: ModelContextMetadata | null;
      protocol: "openai" | "anthropic" | "google" | "acp";
    };
    try {
      credentials = (await api.channels.getCredentials(channelId, modelId)).credentials;
    } catch (error) {
      await failRun(
        error instanceof Error
          ? error.message
          : getScheduledTaskLabel("scheduledTask.run.credentialsFailed"),
        modelId,
      );
      return;
    }
    const model = modelId || credentials.modelId;
    resolvedModel = model;

    if (
      credentials.protocol !== "anthropic" &&
      credentials.protocol !== "openai" &&
      credentials.protocol !== "acp"
    ) {
      await failRun(
        `${getScheduledTaskLabel("scheduledTask.run.unsupportedProtocol")}：${credentials.protocol}`,
        model,
      );
      return;
    }

    // ACP channels carry the local agent launch config JSON-encoded in the apiKey
    // slot, same as the composer path.
    let acpAgent: { command: string; args?: string[]; env?: Record<string, string> } | undefined;
    if (credentials.protocol === "acp") {
      try {
        const parsed = JSON.parse(credentials.apiKey) as {
          command?: string;
          args?: string[];
          env?: Record<string, string>;
        };
        if (!parsed.command || typeof parsed.command !== "string")
          throw new Error("missing command");
        acpAgent = { command: parsed.command, args: parsed.args, env: parsed.env };
      } catch {
        await failRun(getScheduledTaskLabel("scheduledTask.run.startFailed"), model);
        return;
      }
    }

    // MCP/skills/settings are additive. Workspace resolution is mandatory and
    // belongs to this run, independently of another turn's later workspace RPC.
    let mcpServers: Record<string, Record<string, unknown>> | undefined;
    try {
      mcpServers = await resolveEnabledMcpServers(api);
    } catch {
      mcpServers = undefined;
    }
    let projectRoot = resolveProjectRootForConversation(conversation);
    if (conversation.projectId && !projectRoot) {
      // Startup can claim due tasks before the sidebar's project load finishes.
      await useProjectStore
        .getState()
        .loadProjects()
        .catch(() => {});
      projectRoot = resolveProjectRootForConversation(conversation);
    }
    if (conversation.projectId && !projectRoot) {
      await failRun(getChatLabel("chat.run.workspaceUnavailable"), model);
      return;
    }
    let preparedWorkspaceRoot: string | null = null;
    try {
      preparedWorkspaceRoot = await useSidecarStore.getState().ensureWorkspace(projectRoot);
    } catch {
      // A failed preparation cannot reuse a previous turn's workspace.
    }
    if (!preparedWorkspaceRoot) {
      await failRun(getChatLabel("chat.run.workspaceUnavailable"), model);
      return;
    }
    const workspaceRoot = preparedWorkspaceRoot;
    let skills: Awaited<ReturnType<typeof resolveEnabledSkills>> | undefined;
    if (credentials.protocol === "anthropic" || credentials.protocol === "openai") {
      try {
        const resolved = await resolveEnabledSkills({
          prompt: task.prompt,
          required: recipeSpec?.requirements.skills,
        });
        if (resolved.length > 0) skills = resolved;
      } catch {
        skills = undefined;
      }
    }
    const conversationHistory = await loadConversationHistory(conversationId);
    const { systemPrompt, tavilyApiKey, deepseekApiKey, searchProvider } = await resolveRunSettings(
      api,
      forceWebSearch,
    );
    if (recipeSpec) {
      const spec = recipeSpec;
      const localExtensions =
        credentials.protocol === "anthropic" || credentials.protocol === "openai";
      const missing = missingRecipeCapabilities(spec.requirements, {
        skills: localExtensions ? (skills ?? []).map((skill) => skill.name) : [],
        mcpServers: localExtensions ? Object.keys(mcpServers ?? {}) : [],
        workspace: !!workspaceRoot && (!spec.requirements.workspace || !!conversation.projectId),
        webSearch: localExtensions && forceWebSearch,
      });
      if (missing.length > 0) {
        await failRun(
          `${getScheduledTaskLabel("scheduledTask.run.requirementsMissing")}${missing.join(", ")}`,
          model,
        );
        return;
      }
    }
    if (!executionLease.lease.isLive()) return;

    const outcome = await new Promise<{ ok: true } | { ok: false; error: string }>((resolve) => {
      let sidecarRunId: string | null = null;
      let settled = false;
      let cancellationRequested = false;
      const cancel = () => {
        cancellationRequested = true;
        if (sidecarRunId) void client.cancelRun(sidecarRunId).catch(() => {});
      };
      const settle = (result: { ok: true } | { ok: false; error: string }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        executionLease.lease.signal.removeEventListener("abort", onLeaseLost);
        resolve(result);
      };
      const onLeaseLost = () => {
        cancel();
        settle({ ok: false, error: getScheduledTaskLabel("scheduledTask.run.leaseLost") });
      };
      executionLease.lease.signal.addEventListener("abort", onLeaseLost, { once: true });
      const timeout = setTimeout(() => {
        cancel();
        settle({ ok: false, error: getScheduledTaskLabel("scheduledTask.run.timeout") });
      }, RUN_TIMEOUT_MS);
      client
        .runAgent({
          prompt: task.prompt,
          workspaceRoot,
          apiKey: credentials.protocol === "acp" ? "" : credentials.apiKey,
          model,
          contextWindow: credentials.contextWindow,
          contextMetadata: credentials.contextMetadata,
          baseUrl: credentials.baseUrl ?? undefined,
          protocol: credentials.protocol,
          acpAgent,
          // Unattended: nobody is there to answer an approval prompt, so the run
          // gets the full-access mode a user would toggle for a hands-off task.
          permissionMode: "full-access",
          systemPrompt,
          webSearchEnabled: conversation.forceWebSearch,
          tavilyApiKey,
          deepseekApiKey,
          searchProvider,
          mcpServers,
          skills,
          conversationHistory: conversationHistory.length > 0 ? conversationHistory : undefined,
          onEvent: (event) => {
            if (settled || !ownsMessage()) return;
            const result = applySidecarEventToChat(assistantMessageId, event);
            if (result.kind === "usage") runUsage = result.usage;
            if (result.kind === "done") settle({ ok: true });
          },
          onApproval: (request) => {
            void client
              .respondApproval(request.toolUseId, !settled && ownsMessage())
              .catch(() => {});
          },
          onError: (message) => {
            if (settled) return;
            cancel();
            settle({ ok: false, error: message });
          },
          onDone: () => {
            if (settled || !ownsMessage()) return;
            // Some transports deliver completion before their projected done event.
            useChatStore.getState().applyStreamEvent(assistantMessageId, {
              type: "done",
              messageId: assistantMessageId,
            });
            settle({ ok: true });
          },
        })
        .then((runId) => {
          sidecarRunId = runId;
          if (cancellationRequested || !executionLease.lease.isLive())
            void client.cancelRun(runId).catch(() => {});
        })
        .catch((error: unknown) => {
          settle({
            ok: false,
            error:
              error instanceof Error
                ? error.message
                : getScheduledTaskLabel("scheduledTask.run.startFailed"),
          });
        });
    });

    if (!outcome.ok) {
      await failRun(outcome.error, model);
      return;
    }
    const assistantMsg = useChatStore.getState().findMessageAnywhere(assistantMessageId);
    const assistantContent = assistantMsg?.content || "";
    const saved = await persistOnce(assistantContent, assistantMsg?.agentRun ?? undefined, model);
    if (!saved) {
      const error = getScheduledTaskLabel("scheduledTask.run.saveFailed");
      await completeRun(run.id, { status: "failed", error });
      notifyOutcome(task, { ok: false, error });
      return;
    }
    const completed = await completeRun(run.id, {
      status: "completed",
      result: summarize(assistantContent) || getScheduledTaskLabel("scheduledTask.run.noOutput"),
    });
    if (completed) notifyOutcome(task, { ok: true });
  } catch (error) {
    await failRun(
      error instanceof Error
        ? error.message
        : getScheduledTaskLabel("scheduledTask.run.startFailed"),
      resolvedModel,
    );
  } finally {
    useChatStore.getState().unmarkMessagesActive([userMessageId, assistantMessageId]);
    if (!executionLease.lease.isLive() && isRunOwner(assistantMessageId, ownerToken)) {
      const message = useChatStore.getState().findMessageAnywhere(assistantMessageId);
      if (message?.agentRun?.status === "partial") {
        useChatStore.getState().applyStreamEvent(assistantMessageId, {
          type: "error",
          message: getScheduledTaskLabel("scheduledTask.run.leaseLost"),
        });
      }
    }
  }
}

async function loadConversationHistory(
  conversationId: string,
): Promise<Array<{ role: "user" | "assistant"; content: string }>> {
  try {
    const { messages } = await api.messages.list(conversationId);
    return buildConversationHistory(messages);
  } catch {
    return [];
  }
}

/** Waits for the sidecar to be usable, giving up after SIDECAR_WAIT_MS. */
function waitForSidecar(): Promise<SidecarClient | null> {
  const current = useSidecarStore.getState();
  if (current.status === "ready" && current.client) return Promise.resolve(current.client);
  if (current.status === "error" || current.status === "unsupported") return Promise.resolve(null);
  return new Promise((resolve) => {
    const finish = (client: SidecarClient | null) => {
      clearTimeout(timeout);
      unsub();
      resolve(client);
    };
    const unsub = useSidecarStore.subscribe((state) => {
      if (state.status === "ready" && state.client) finish(state.client);
      else if (state.status === "error" || state.status === "unsupported") finish(null);
    });
    const timeout = setTimeout(() => finish(null), SIDECAR_WAIT_MS);
  });
}

function notifyOutcome(task: ScheduledTask, outcome: { ok: true } | { ok: false; error: string }) {
  if (!task.notifyOnComplete) return;
  if (outcome.ok) {
    notifySuccess(getScheduledTaskLabel("scheduledTask.notify.runCompletedTitle"), task.title);
  } else {
    notifyError(
      getScheduledTaskLabel("scheduledTask.notify.runFailedBgTitle"),
      `${task.title}：${outcome.error}`,
    );
  }
}

function summarize(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= RESULT_SUMMARY_CHARS) return collapsed;
  return `${collapsed.slice(0, RESULT_SUMMARY_CHARS)}…`;
}

/** Stable token retries a lost claim ACK without starting a second execution. */
async function claimRun(runId: string): Promise<"claimed" | "taken" | "error"> {
  const ownerToken = claimTokens.get(runId) ?? crypto.randomUUID();
  claimTokens.set(runId, ownerToken);
  const backendBase = getDesktopBackendBase();
  const acquiredAt = performance.now();
  try {
    const res = await fetchWithBackendStatus(`${backendBase}/scheduled-tasks/runs/${runId}/claim`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ownerToken }),
    });
    if (!res.ok) return "error";
    const data = (await res.json()) as { claimed?: boolean; leaseDurationMs: number };
    if (!data.claimed) {
      claimTokens.delete(runId);
      return "taken";
    }
    const lease = createScheduledRunLease({
      acquiredAt,
      durationMs: data.leaseDurationMs,
      heartbeat: async () => {
        const response = await fetchWithBackendStatus(
          `${backendBase}/scheduled-tasks/runs/${runId}/heartbeat`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ownerToken }),
          },
        );
        if (response.status === 409 || response.status === 404 || response.status === 400)
          return null;
        if (!response.ok) throw new Error("Task heartbeat unavailable");
        const result = (await response.json()) as { renewed: boolean; leaseDurationMs: number };
        return result.renewed ? result.leaseDurationMs : null;
      },
    });
    if (!lease.isLive()) {
      lease.stop();
      claimTokens.delete(runId);
      return "taken";
    }
    runLeases.set(runId, { ownerToken, backendBase, lease });
    return "claimed";
  } catch {
    return "error";
  }
}

async function completeRun(
  runId: string,
  body: { status: "completed" | "failed"; result?: string; error?: string },
): Promise<boolean> {
  const execution = runLeases.get(runId);
  if (!execution || !(await execution.lease.renew())) return false;
  try {
    const response = await fetchWithBackendStatus(
      `${execution.backendBase}/scheduled-tasks/runs/${runId}/complete`,
      {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, ownerToken: execution.ownerToken }),
      },
    );
    return response.ok;
  } catch {
    // An unreachable server cannot be called completed. The lease expires and
    // the server reports interruption instead of preserving running forever.
    return false;
  }
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}
