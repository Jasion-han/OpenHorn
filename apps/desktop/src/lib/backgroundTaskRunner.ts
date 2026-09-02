import type { ScheduledTask, ScheduledTaskRun } from "shared/types";
import { claimRunOwnership, createRunPersistGuard, isRunOwner } from "../hooks/sidecarRunOwnership";
import { useChatStore } from "../stores/chatStore";
import { useScheduledTaskStore } from "../stores/scheduledTaskStore";
import { useSidecarStore } from "../stores/sidecarStore";
import type { Message } from "../types/chat";
import { getDesktopBackendBase } from "./backendBase";
import { getEffectiveModelForConversation } from "./effectiveModel";
import { getScheduledTaskLabel } from "./i18n/agent";
import { notifyError, notifySuccess } from "./notify";
import { createServerApi } from "./serverApi";
import type { SidecarClient } from "./sidecarClient";
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
// A pending run older than this was due while the app was closed; it is
// recorded as missed rather than executed hours late.
const MISSED_GRACE_MS = 15 * 60_000;
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
const handledRunIds = new Set<string>();

export function startBackgroundTaskRunner() {
  if (initialized) return;
  initialized = true;

  // Any change to the task list (create / edit / toggle / delete / reload after a
  // run) can move the earliest due time: re-arm from the fresh list.
  useScheduledTaskStore.subscribe((state, prev) => {
    if (state.tasks !== prev.tasks) armDueTimer(state.tasks);
  });

  void (async () => {
    await useScheduledTaskStore.getState().loadTasks();
    await failInterruptedRuns();
    await sweepPendingRuns();
  })();
  setInterval(() => void sweepPendingRuns(), FALLBACK_POLL_MS);
}

/**
 * A fresh page means no run of this client can still be in flight: anything
 * left `running` was cut off by a reload or crash mid-turn (its sidecar run,
 * if any, has no listener any more). Record that instead of leaving the row
 * "running" indefinitely.
 */
async function failInterruptedRuns() {
  const store = useScheduledTaskStore.getState();
  await store.loadRuns();
  const interrupted = useScheduledTaskStore.getState().runs.filter((r) => r.status === "running");
  for (const run of interrupted) {
    await completeRun(run.id, {
      status: "failed",
      error: getScheduledTaskLabel("scheduledTask.run.interrupted"),
    });
  }
  if (interrupted.length > 0) void useScheduledTaskStore.getState().loadRuns();
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
    await useScheduledTaskStore.getState().loadRuns();
    let picked = false;
    for (const run of useScheduledTaskStore.getState().runs) {
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
  if (Date.now() - run.startedAt.getTime() > MISSED_GRACE_MS) {
    await completeRun(run.id, {
      status: "failed",
      error: getScheduledTaskLabel("scheduledTask.run.missed"),
    });
    void useScheduledTaskStore.getState().loadRuns();
    return;
  }
  const claim = await claimRun(run.id);
  if (claim === "error") {
    // Transient (server unreachable): let the next sweep try again.
    handledRunIds.delete(run.id);
    return;
  }
  if (claim === "taken") return;

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

  try {
    await executeRun(run, task);
  } finally {
    const scheduled = useScheduledTaskStore.getState();
    void scheduled.loadRuns();
    void scheduled.loadTasks();
    // The task's conversation now has content and a fresh updatedAt; the
    // sidebar reads both from the conversation list.
    void useChatStore.getState().loadConversations();
  }
}

async function executeRun(run: ScheduledTaskRun, task: ScheduledTask) {
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
  const now = Date.now();
  const userMessageId = `temp-${now}`;
  const assistantMessageId = `temp-assistant-${now}`;
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
  const ownsMessage = () => isRunOwner(assistantMessageId, ownerToken);
  const shouldPersist = createRunPersistGuard(assistantMessageId, ownerToken);

  let runUsage: RunUsage | null = null;

  // One-shot persistence through the same endpoint a typed turn uses, followed
  // by the same draft → server id reconciliation; a failed run keeps the user's
  // message and its failure state in the DB just like the composer path.
  const persistOnce = async (assistantContent: string, agentRun: unknown, model: string) => {
    if (!shouldPersist()) return;
    let stampId = assistantMessageId;
    try {
      const res = await api.messages.syncSidecar({
        conversationId,
        userContent: task.prompt,
        assistantContent,
        model,
        agentRun: agentRun ?? undefined,
        usage: runUsage ?? undefined,
      });
      if (res?.userMessageId && res?.assistantMessageId) {
        useChatStore.getState().reconcileSidecarMessageIds({
          conversationId,
          assistantDraftId: assistantMessageId,
          userMessageId: res.userMessageId,
          assistantMessageId: res.assistantMessageId,
        });
        stampId = res.assistantMessageId;
      }
    } catch {
      // Best-effort: a persistence failure must not affect the UI.
    } finally {
      useChatStore.getState().unmarkMessagesActive([userMessageId, assistantMessageId]);
      useChatStore.getState().updateMessage(stampId, {
        updatedAt: new Date(),
        ...(runUsage ? { usage: runUsage } : {}),
      });
    }
  };

  const failRun = async (message: string, model: string) => {
    if (!ownsMessage()) return;
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

  let credentials: {
    apiKey: string;
    baseUrl: string | null;
    modelId: string;
    protocol: "openai" | "anthropic" | "google" | "acp";
  };
  try {
    credentials = (await api.channels.getCredentials(channelId)).credentials;
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
      if (!parsed.command || typeof parsed.command !== "string") throw new Error("missing command");
      acpAgent = { command: parsed.command, args: parsed.args, env: parsed.env };
    } catch {
      await failRun(getScheduledTaskLabel("scheduledTask.run.startFailed"), model);
      return;
    }
  }

  // Additive inputs, each best-effort exactly like the composer: MCP roster,
  // workspace re-sync, enabled skills, global system prompt + Tavily key.
  let mcpServers: Record<string, Record<string, unknown>> | undefined;
  try {
    mcpServers = await resolveEnabledMcpServers(api);
  } catch {
    mcpServers = undefined;
  }
  try {
    await useSidecarStore.getState().ensureWorkspace();
  } catch {
    // the sidecar keeps whatever workspace it already has
  }
  let skills: Awaited<ReturnType<typeof resolveEnabledSkills>> | undefined;
  if (credentials.protocol === "anthropic" || credentials.protocol === "openai") {
    try {
      const resolved = await resolveEnabledSkills();
      if (resolved.length > 0) skills = resolved;
    } catch {
      skills = undefined;
    }
  }
  const conversationHistory = await loadConversationHistory(conversationId);
  const { systemPrompt, tavilyApiKey } = await resolveRunSettings(api, forceWebSearch);

  const outcome = await new Promise<{ ok: true } | { ok: false; error: string }>((resolve) => {
    let sidecarRunId: string | null = null;
    let settled = false;
    const settle = (result: { ok: true } | { ok: false; error: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    };
    const timeout = setTimeout(() => {
      if (sidecarRunId) void client.cancelRun(sidecarRunId).catch(() => {});
      settle({ ok: false, error: getScheduledTaskLabel("scheduledTask.run.timeout") });
    }, RUN_TIMEOUT_MS);
    client
      .runAgent({
        prompt: task.prompt,
        apiKey: credentials.protocol === "acp" ? "" : credentials.apiKey,
        model,
        baseUrl: credentials.baseUrl ?? undefined,
        protocol: credentials.protocol,
        acpAgent,
        // Unattended: nobody is there to answer an approval prompt, so the run
        // gets the full-access mode a user would toggle for a hands-off task.
        permissionMode: "full-access",
        systemPrompt,
        webSearchEnabled: conversation.forceWebSearch,
        tavilyApiKey,
        mcpServers,
        skills,
        conversationHistory: conversationHistory.length > 0 ? conversationHistory : undefined,
        onEvent: (event) => {
          if (!ownsMessage()) return;
          const result = applySidecarEventToChat(assistantMessageId, event);
          if (result.kind === "usage") runUsage = result.usage;
          if (result.kind === "done") settle({ ok: true });
        },
        onApproval: (request) => {
          void client.respondApproval(request.toolUseId, true).catch(() => {});
        },
        onError: (message) => settle({ ok: false, error: message }),
        onDone: () => settle({ ok: true }),
      })
      .then((runId) => {
        sidecarRunId = runId;
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
  await persistOnce(assistantContent, assistantMsg?.agentRun ?? undefined, model);
  await completeRun(run.id, {
    status: "completed",
    result: summarize(assistantContent) || getScheduledTaskLabel("scheduledTask.run.noOutput"),
  });
  notifyOutcome(task, { ok: true });
}

async function loadConversationHistory(
  conversationId: string,
): Promise<Array<{ role: "user" | "assistant"; content: string }>> {
  try {
    const { messages } = await api.messages.list(conversationId);
    const history: Array<{ role: "user" | "assistant"; content: string }> = [];
    for (const m of messages) {
      const text = (m.content || "").trim();
      if (!text) continue;
      if (m.role === "user" || m.role === "assistant")
        history.push({ role: m.role, content: text });
    }
    return history;
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

/** "taken" = another client (or an earlier attempt) already owns this run. */
async function claimRun(runId: string): Promise<"claimed" | "taken" | "error"> {
  try {
    const res = await fetch(`${getDesktopBackendBase()}/scheduled-tasks/runs/${runId}/claim`, {
      method: "PATCH",
      credentials: "include",
    });
    if (!res.ok) return "error";
    const data = (await res.json()) as { claimed?: boolean };
    return data.claimed === true ? "claimed" : "taken";
  } catch {
    return "error";
  }
}

async function completeRun(
  runId: string,
  body: { status: "completed" | "failed"; result?: string; error?: string },
) {
  try {
    await fetch(`${getDesktopBackendBase()}/scheduled-tasks/runs/${runId}/complete`, {
      method: "PATCH",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    // Best-effort: the run stays "running" in the list; the turn itself is
    // already persisted in the conversation.
  }
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}
