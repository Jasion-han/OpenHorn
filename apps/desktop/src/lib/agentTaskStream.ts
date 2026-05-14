export type AgentTaskStreamEvent =
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
  | {
      type: "error";
      taskId?: string;
      runId?: string;
      content: string;
      metadata?: unknown;
    }
  | { type: "done"; taskId: string; runId: string };
