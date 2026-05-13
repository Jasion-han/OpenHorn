import type {
  ApiAgentPlanStep,
  ApiAgentTaskStatus,
  ApiCitation,
} from "../types/chat";

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
