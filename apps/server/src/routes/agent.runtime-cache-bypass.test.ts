import { expect, test } from "bun:test";
import { createAgentRouter } from "./agent";

test("task execute re-probes compatibility with bypassCache before running", async () => {
  const runtimeCalls: Array<Record<string, unknown>> = [];
  const createdEvents: Array<Record<string, unknown>> = [];

  const task = {
    id: "task-1",
    userId: "user-1",
    conversationId: "conv-1",
    channelId: "channel-1",
    modelId: "qwen3.5-plus",
    title: "Agent task",
    goal: "Use the selected channel to finish the task.",
    attachments: [],
    complexity: "standard" as const,
    uxMode: "compact" as const,
    requiresPlanApproval: true,
    autoStart: true,
    status: "draft" as const,
    insight: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const agent = createAgentRouter({
    requireUserMiddleware: async (c, next) => {
      c.set("user", { id: "user-1" } as never);
      await next();
    },
    getAgentTaskById: async () => task,
    getLatestApprovalForTask: async () => ({
      id: "approval-1",
      runId: "plan-run-1",
      status: "approved",
    }),
    getLatestRunForTask: async (_userId: string, _taskId: string, phase?: string) =>
      phase === "planning"
        ? {
            id: "plan-run-1",
            taskId: "task-1",
            phase: "planning",
            status: "completed",
          }
        : null,
    getResolvedChannelForConversation: async () => ({
      channel: {
        id: "channel-1",
        name: "Qwen Relay",
        provider: "anthropic",
        protocol: "anthropic",
        baseUrl: "https://coding.dashscope.aliyuncs.com/apps/anthropic",
      },
      modelId: "qwen3.5-plus",
      apiKey: "test-key",
    }),
    resolveAgentRuntime: async (params: Record<string, unknown>) => {
      runtimeCalls.push(params);
      return {
        success: true as const,
        resolvedChannel: {
          channel: {
            id: "channel-1",
            name: "Qwen Relay",
            provider: "anthropic",
            protocol: "anthropic",
            baseUrl: "https://coding.dashscope.aliyuncs.com/apps/anthropic",
          },
          modelId: "qwen3.5-plus",
          apiKey: "test-key",
        },
        compatibility: { success: true as const, mode: "generic_tool_calling" as const },
        fallbackUsed: false,
        attempts: [],
      };
    },
    getAgentTaskDetail: async () => ({
      task,
      runs: [],
      planSteps: [
        {
          id: "step-1",
          taskId: "task-1",
          runId: "plan-run-1",
          orderIndex: 0,
          title: "Inspect the current task",
          description: "Use the selected channel and model to run the task.",
          status: "pending",
        },
      ],
      approvals: [],
      artifacts: [],
      events: [],
      runtime: null,
    }),
    createAgentRun: async (_userId: string, taskId: string, input: Record<string, unknown>) => ({
      id: `${String(input.phase)}-run-1`,
      taskId,
      phase: input.phase,
      status: input.status ?? "running",
    }),
    createAgentTaskEvent: async (_userId: string, taskId: string, runId: string, input: Record<string, unknown>) => {
      const event = { taskId, runId, ...input };
      createdEvents.push(event);
      return event;
    },
    updateAgentTaskStatus: async () => task,
    updateAgentRunStatus: async () => null,
    updateAgentPlanStepStatuses: async () => [],
    createAgentArtifact: async () => null,
    buildAgentRuntimeContext: async () => ({
      channelId: "channel-1",
      modelId: "qwen3.5-plus",
      globalSystemPrompt: undefined,
      liveSystemContext: undefined,
      liveContext: { status: "offline", route: "direct_model" },
    }),
    getAgentCapabilityModeFromSuccessResult: () => "generic_tool_calling",
    runAgentWithConfig: async function* () {
      yield { type: "text", content: "Task finished." };
    },
    createAgentStreamTimeoutGuard: () => ({
      markVisibleOutput() {},
      markActivity() {},
      cleanup() {},
    }),
  });

  const response = await agent.request("/tasks/task-1/execute", { method: "POST" });
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  await response.text();

  expect(runtimeCalls).toEqual([
    {
      userId: "user-1",
      requestedChannelId: "channel-1",
      requestedModelId: "qwen3.5-plus",
      bypassCache: true,
    },
  ]);
  expect(
    createdEvents.some(
      (event) =>
        event.type === "execution_event" &&
        event.metadata &&
        typeof event.metadata === "object" &&
        (event.metadata as { eventType?: string }).eventType === "text",
    ),
  ).toBe(true);
});

test("task execute preserves live search failure instead of falling back to model execution", async () => {
  let runAgentCalled = false;
  const createdEvents: Array<Record<string, unknown>> = [];
  const runStatuses: string[] = [];
  const taskStatuses: string[] = [];

  const task = {
    id: "task-1",
    userId: "user-1",
    conversationId: "conv-1",
    channelId: "channel-1",
    modelId: "qwen3.5-plus",
    title: "Search task",
    goal: "请联网搜索 OpenAI 官网首页标题。",
    attachments: [],
    complexity: "standard" as const,
    uxMode: "compact" as const,
    requiresPlanApproval: true,
    autoStart: true,
    status: "draft" as const,
    insight: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const agent = createAgentRouter({
    requireUserMiddleware: async (c, next) => {
      c.set("user", { id: "user-1" } as never);
      await next();
    },
    getAgentTaskById: async () => task,
    getLatestApprovalForTask: async () => ({
      id: "approval-1",
      runId: "plan-run-1",
      status: "approved",
    }),
    getLatestRunForTask: async (_userId: string, _taskId: string, phase?: string) =>
      phase === "planning"
        ? {
            id: "plan-run-1",
            taskId: "task-1",
            phase: "planning",
            status: "completed",
          }
        : null,
    getResolvedChannelForConversation: async () => ({
      channel: {
        id: "channel-1",
        name: "Qwen Relay",
        provider: "anthropic",
        protocol: "anthropic",
        baseUrl: "https://coding.dashscope.aliyuncs.com/apps/anthropic",
      },
      modelId: "qwen3.5-plus",
      apiKey: "test-key",
    }),
    resolveAgentRuntime: async () => ({
      success: true as const,
      resolvedChannel: {
        channel: {
          id: "channel-1",
          name: "Qwen Relay",
          provider: "anthropic",
          protocol: "anthropic",
          baseUrl: "https://coding.dashscope.aliyuncs.com/apps/anthropic",
        },
        modelId: "qwen3.5-plus",
        apiKey: "test-key",
      },
      compatibility: { success: true as const, mode: "generic_tool_calling" as const },
      fallbackUsed: false,
      attempts: [],
    }),
    getAgentTaskDetail: async () => ({
      task,
      runs: [],
      planSteps: [
        {
          id: "step-1",
          taskId: "task-1",
          runId: "plan-run-1",
          orderIndex: 0,
          title: "Search the web",
          description: "Use real web search before answering.",
          status: "pending",
        },
      ],
      approvals: [],
      artifacts: [],
      events: [],
      runtime: null,
    }),
    createAgentRun: async (_userId: string, taskId: string, input: Record<string, unknown>) => ({
      id: `${String(input.phase)}-run-1`,
      taskId,
      phase: input.phase,
      status: input.status ?? "running",
    }),
    createAgentTaskEvent: async (_userId: string, taskId: string, runId: string, input: Record<string, unknown>) => {
      const event = { taskId, runId, ...input };
      createdEvents.push(event);
      return event;
    },
    updateAgentTaskStatus: async (_userId: string, _taskId: string, status: string) => {
      taskStatuses.push(status);
      return task;
    },
    updateAgentRunStatus: async (_userId: string, _runId: string, status: string) => {
      runStatuses.push(status);
      return null;
    },
    updateAgentPlanStepStatuses: async () => [],
    createAgentArtifact: async () => null,
    buildAgentRuntimeContext: async () => ({
      channelId: "channel-1",
      modelId: "qwen3.5-plus",
      globalSystemPrompt: undefined,
      liveSystemContext: "Live search timed out.",
      liveContext: {
        status: "offline",
        route: "web_search",
        userLabel: "实时搜索超时，任务已停止",
        source: { type: "none" },
        citations: [],
      },
    }),
    getAgentCapabilityModeFromSuccessResult: () => "generic_tool_calling",
    runAgentWithConfig: async function* () {
      runAgentCalled = true;
      yield { type: "text", content: "should not run" };
    },
    createAgentStreamTimeoutGuard: () => ({
      markVisibleOutput() {},
      markActivity() {},
      cleanup() {},
    }),
  });

  const response = await agent.request("/tasks/task-1/execute", { method: "POST" });
  expect(response.status).toBe(200);
  await response.text();

  expect(runAgentCalled).toBe(false);
  expect(
    createdEvents.some(
      (event) =>
        event.type === "execution_event" &&
        event.toolName === "web_search" &&
        event.metadata &&
        typeof event.metadata === "object" &&
        (event.metadata as { eventType?: string; source?: string }).eventType === "tool_start" &&
        (event.metadata as { eventType?: string; source?: string }).source === "live_context",
    ),
  ).toBe(true);
  expect(
    createdEvents.some(
      (event) => event.type === "error" && event.content === "实时搜索超时，任务已停止",
    ),
  ).toBe(true);
  expect(runStatuses).toContain("failed");
  expect(taskStatuses).toContain("failed");
});
