import type { ScheduledTaskRun } from "shared/types";
import { getDesktopBackendBase } from "./backendBase";
import { createServerApi } from "./serverApi";
import { useSidecarStore } from "../stores/sidecarStore";
import { useScheduledTaskStore } from "../stores/scheduledTaskStore";

const processedRuns = new Set<string>();
let initialized = false;

const api = createServerApi();

export function startBackgroundTaskRunner() {
  if (initialized) return;
  initialized = true;
  void pollForNewRuns();
  setInterval(() => void pollForNewRuns(), 15_000);
}

async function pollForNewRuns() {
  try {
    const base = getDesktopBackendBase();
    const res = await fetch(`${base}/scheduled-tasks/runs`);
    if (!res.ok) return;
    const data = (await res.json()) as { runs: ScheduledTaskRun[] };

    if (processedRuns.size === 0) {
      for (const run of data.runs) processedRuns.add(run.id);
      return;
    }

    for (const run of data.runs) {
      if (processedRuns.has(run.id)) continue;
      processedRuns.add(run.id);

      if (!run.conversationId) continue;

      const task = useScheduledTaskStore.getState().tasks.find((t) => t.id === run.taskId);
      if (!task) continue;

      void executeInBackground(run.conversationId, task.prompt, task.title);
    }
  } catch {
    // silently retry
  }
}

async function executeInBackground(conversationId: string, prompt: string, title: string) {
  const sidecar = useSidecarStore.getState();
  if (!sidecar.client || sidecar.status !== "ready") return;

  const base = getDesktopBackendBase();

  const convRes = await fetch(`${base}/conversations/${conversationId}`);
  if (!convRes.ok) return;
  const convData = (await convRes.json()) as {
    conversation: { channelId?: string; modelId?: string };
  };
  const { channelId, modelId } = convData.conversation;
  if (!channelId) return;

  let credentials: {
    apiKey: string;
    baseUrl: string | null;
    modelId: string;
    protocol: string;
  };
  try {
    const result = await api.channels.getCredentials(channelId);
    credentials = result.credentials;
  } catch {
    return;
  }

  if (credentials.protocol !== "anthropic" && credentials.protocol !== "openai") return;

  const effectiveModel = modelId || credentials.modelId;
  const fullPrompt = `[定时任务自动触发] ${prompt}`;

  await fetch(`${base}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      conversationId,
      content: fullPrompt,
      mode: "agent",
    }),
  });

  const events: string[] = [];

  try {
    await new Promise<void>((resolve, reject) => {
      void sidecar.client!.runAgent({
        prompt: fullPrompt,
        apiKey: credentials.apiKey,
        model: effectiveModel,
        baseUrl: credentials.baseUrl || undefined,
        protocol: credentials.protocol,
        permissionMode: "full-access",
        webSearchEnabled: false,
        onEvent: (event) => {
          if (event.type === "execution_event" && event.content) {
            events.push(event.content);
          }
        },
        onApproval: () => {},
        onError: (msg) => reject(new Error(msg)),
        onDone: () => resolve(),
      });
    });

    const responseText = events.join("") || "✅ 已完成。";
    await fetch(`${base}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        conversationId,
        content: responseText,
        role: "assistant",
        mode: "agent",
      }),
    });
  } catch (err) {
    const errorText = err instanceof Error ? err.message : "执行失败";
    await fetch(`${base}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        conversationId,
        content: `Execution Failed: ${errorText}`,
        role: "assistant",
        mode: "agent",
      }),
    });
  }

  void useScheduledTaskStore.getState().loadRuns();
}
