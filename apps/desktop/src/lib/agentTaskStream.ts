import type {
  ApiAgentPlanStep,
  ApiAgentTaskStatus,
  ApiCitation,
} from "../types/chat";
import { readErrorMessage, createServerApi } from "./serverApi";
import { readTypedSseStream } from "./sse";

const api = createServerApi();

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
      metadata?: unknown;
    }
  | { type: "artifact_created"; taskId: string; runId: string; artifactType: string }
  | {
      type: "final_result";
      taskId: string;
      runId: string;
      content: string;
      citations?: ApiCitation[];
    }
  | {
      type: "error";
      taskId?: string;
      runId?: string;
      content: string;
      metadata?: unknown;
    }
  | { type: "done"; taskId: string; runId: string };

export async function streamAgentTaskExecution(
  taskId: string,
  handlers: {
    onEvent: (event: AgentTaskStreamEvent) => void | Promise<void>;
    onError: (message: string, metadata?: unknown) => void;
  },
  options?: {
    signal?: AbortSignal;
    response?: Response;
    action?: "execute" | "retry" | "continue";
  },
) {
  const action = options?.action || "execute";
  const response =
    options?.response ??
    (action === "retry"
      ? await api.agentTasks.retry(taskId, { signal: options?.signal })
      : action === "continue"
        ? await api.agentTasks.continue(taskId, { signal: options?.signal })
        : await api.agentTasks.execute(taskId, { signal: options?.signal }));

  if (!response.ok) {
    throw new Error(await readErrorMessage(response, "Failed to execute task"));
  }

  await readTypedSseStream<AgentTaskStreamEvent>(response, async (event) => {
    if (event.type === "error") {
      handlers.onError(event.content || "Task execution failed", event.metadata);
      return;
    }

    await handlers.onEvent(event);
  });
}
