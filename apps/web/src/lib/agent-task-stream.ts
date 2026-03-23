"use client";

import type { ApiAgentPlanStep, ApiAgentTaskStatus, ApiCitation } from "./api";
import { api, readErrorMessage } from "./api";
import { readSseStream, type SseEvent } from "./sse";

export type AgentTaskStreamEvent =
  | { type: "task_status"; taskId: string; runId: string; status: ApiAgentTaskStatus }
  | {
      type: "plan_step";
      taskId: string;
      runId: string;
      stepId: string;
      orderIndex: number;
      title: string;
      status: ApiAgentPlanStep["status"];
    }
  | {
      type: "execution_event";
      taskId: string;
      runId: string;
      eventType?: string;
      content?: string;
      toolName?: string;
      toolInput?: unknown;
    }
  | { type: "artifact_created"; taskId: string; runId: string; artifactType: string }
  | {
      type: "final_result";
      taskId: string;
      runId: string;
      content: string;
      citations?: ApiCitation[];
    }
  | { type: "error"; taskId?: string; runId?: string; content: string }
  | { type: "done"; taskId: string; runId: string };

function isAgentTaskStreamEvent(event: SseEvent): event is AgentTaskStreamEvent {
  return typeof event?.type === "string";
}

export async function streamAgentTaskExecution(
  taskId: string,
  handlers: {
    onEvent: (event: AgentTaskStreamEvent) => void;
    onError: (message: string) => void;
  },
  options?: {
    signal?: AbortSignal;
    response?: Response;
  },
) {
  const response =
    options?.response ?? (await api.agentTasks.execute(taskId, { signal: options?.signal }));

  if (!response.ok) {
    throw new Error(await readErrorMessage(response, "Failed to execute task"));
  }

  await readSseStream(response, (rawEvent) => {
    if (!isAgentTaskStreamEvent(rawEvent)) {
      return;
    }

    if (rawEvent.type === "error") {
      handlers.onError(rawEvent.content || "Task execution failed");
      return;
    }

    handlers.onEvent(rawEvent);
  });
}
