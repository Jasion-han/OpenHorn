import { expect, mock, test } from "bun:test";

test("task routes cover create, list, detail, plan, approval, and execute preconditions", async () => {
  const tasks: Array<Record<string, unknown>> = [];
  const runs: Array<Record<string, unknown>> = [];
  const planSteps: Array<Record<string, unknown>> = [];
  const approvals: Array<Record<string, unknown>> = [];
  const events: Array<Record<string, unknown>> = [];
  const artifacts: Array<Record<string, unknown>> = [];

  const buildDetail = (taskId: string) => {
    const task = tasks.find((item) => item.id === taskId) ?? null;
    return {
      task,
      runs: runs.filter((item) => item.taskId === taskId),
      planSteps: planSteps.filter((item) => item.taskId === taskId),
      approvals: approvals.filter((item) => item.taskId === taskId),
      artifacts: artifacts.filter((item) => item.taskId === taskId),
      events: events.filter((item) => item.taskId === taskId),
    };
  };

  mock.module("../services/authService", () => ({
    verifyToken: async () => ({ userId: "user-1" }),
    getUserById: async () => ({ id: "user-1" }),
  }));

  mock.module("../services/agentService", () => ({
    getAgentSessions: async () => [],
    getAgentEvents: async () => [],
    deleteAgentEvent: async () => true,
    getAgentSessionById: async () => null,
    createAgentSession: async () => ({ id: "session-1" }),
    renameAgentSession: async () => ({ success: true }),
    runAgent: async function* () {},
    runAgentWithConfig: async function* () {},
    buildAgentRuntimeContext: async () => ({
      channelId: "channel-1",
      modelId: "claude-3-7-sonnet",
      globalSystemPrompt: undefined,
      liveSystemContext: undefined,
    }),
    updateAgentSessionChannel: async () => ({ success: true }),
    updateAgentSessionStatus: async () => ({ success: true }),
    deleteAgentSession: async () => ({ success: true }),
  }));

  mock.module("../services/agentTaskService", () => ({
    listAgentTasks: async () => tasks,
    getAgentTaskById: async (_userId: string, taskId: string) =>
      tasks.find((item) => item.id === taskId) ?? null,
    getAgentTaskDetail: async (_userId: string, taskId: string) => buildDetail(taskId),
    listAgentTaskEvents: async (_userId: string, taskId: string) =>
      events.filter((item) => item.taskId === taskId),
    listAgentArtifacts: async (_userId: string, taskId: string) =>
      artifacts.filter((item) => item.taskId === taskId),
    createAgentTask: async (_userId: string, input: Record<string, unknown>) => {
      const task = {
        id: "task-1",
        userId: "user-1",
        conversationId: null,
        channelId: null,
        modelId: null,
        title: typeof input.title === "string" && input.title ? input.title : "Task",
        goal: String(input.goal),
        attachments: [],
        status: "draft",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      tasks.push(task);
      return task;
    },
    createAgentRun: async (_userId: string, taskId: string, input: Record<string, unknown>) => {
      const run = {
        id: `run-${runs.length + 1}`,
        taskId,
        phase: input.phase,
        status: input.status ?? "pending",
        summary: null,
        error: null,
        startedAt: new Date().toISOString(),
        completedAt: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      runs.push(run);
      return run;
    },
    createAgentTaskEvent: async (
      _userId: string,
      taskId: string,
      runId: string,
      input: Record<string, unknown>,
    ) => {
      const event = {
        id: `event-${events.length + 1}`,
        taskId,
        runId,
        type: input.type,
        content: input.content ?? null,
        metadata: input.metadata ?? null,
        createdAt: new Date().toISOString(),
      };
      events.push(event);
      return event;
    },
    setAgentPlanSteps: async (
      _userId: string,
      taskId: string,
      runId: string,
      input: { steps: Array<Record<string, unknown>> },
    ) => {
      planSteps.length = 0;
      input.steps.forEach((step, index) => {
        planSteps.push({
          id: `step-${index + 1}`,
          taskId,
          runId,
          orderIndex: index,
          title: step.title,
          description: step.description ?? null,
          status: step.status ?? "pending",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
      });
      return planSteps.filter((item) => item.taskId === taskId);
    },
    createAgentApprovalRequest: async (
      _userId: string,
      taskId: string,
      runId: string,
      input: Record<string, unknown>,
    ) => {
      const approval = {
        id: `approval-${approvals.length + 1}`,
        taskId,
        runId,
        type: input.type,
        status: "pending",
        title: input.title,
        description: input.description ?? null,
        payload: input.payload ?? null,
        response: null,
        requestedAt: new Date().toISOString(),
        respondedAt: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      approvals.push(approval);
      return approval;
    },
    respondToAgentApproval: async (
      _userId: string,
      approvalId: string,
      input: Record<string, unknown>,
    ) => {
      const approval = approvals.find((item) => item.id === approvalId);
      if (!approval) throw new Error("Approval not found");
      approval.status = input.status;
      approval.response = input.response ?? null;
      approval.respondedAt = new Date().toISOString();
      approval.updatedAt = new Date().toISOString();
      return approval;
    },
    getLatestApprovalForTask: async (_userId: string, taskId: string) =>
      approvals
        .filter((item) => item.taskId === taskId)
        .slice()
        .reverse()[0] ?? null,
    createAgentArtifact: async (
      _userId: string,
      taskId: string,
      runId: string,
      input: Record<string, unknown>,
    ) => {
      const artifact = {
        id: `artifact-${artifacts.length + 1}`,
        taskId,
        runId,
        type: input.type,
        title: input.title,
        content: input.content,
        metadata: input.metadata ?? null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      artifacts.push(artifact);
      return artifact;
    },
    updateAgentRunStatus: async (_userId: string, runId: string, status: string) => {
      const run = runs.find((item) => item.id === runId);
      if (run) {
        run.status = status;
      }
      return run ?? null;
    },
    updateAgentTaskStatus: async (_userId: string, taskId: string, status: string) => {
      const task = tasks.find((item) => item.id === taskId);
      if (task) {
        task.status = status;
      }
      return task ?? null;
    },
  }));

  mock.module("../services/autoTitleService", () => ({
    generateAutoTitle: async () => "Title",
  }));

  mock.module("../services/channelService", () => ({
    getResolvedChannelForConversation: async () => ({
      channel: { id: "channel-1", provider: "anthropic" },
      modelId: "claude-3-7-sonnet",
      apiKey: "test-key",
    }),
  }));

  mock.module("../services/channelAgentCheckService", () => ({
    checkChannelAgentCompatibility: async () => ({ success: true }),
  }));

  try {
    const { default: agent } = await import(`./agent?case=${crypto.randomUUID()}`);

    const missingGoal = await agent.request("/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: "token=test-token" },
      body: JSON.stringify({ title: "Missing goal" }),
    });
    expect(missingGoal.status).toBe(400);

    const createResponse = await agent.request("/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: "token=test-token" },
      body: JSON.stringify({ title: "Task", goal: "Ship the agent workbench." }),
    });
    const createJson = (await createResponse.json()) as { task: { id: string } };
    expect(createResponse.status).toBe(201);
    expect(createJson.task.id).toBe("task-1");

    const listResponse = await agent.request("/tasks", {
      method: "GET",
      headers: { Cookie: "token=test-token" },
    });
    const listJson = (await listResponse.json()) as { tasks: Array<{ id: string }> };
    expect(listResponse.status).toBe(200);
    expect(listJson.tasks).toHaveLength(1);

    const detailResponse = await agent.request("/tasks/task-1", {
      method: "GET",
      headers: { Cookie: "token=test-token" },
    });
    const detailJson = (await detailResponse.json()) as { task: { id: string } };
    expect(detailResponse.status).toBe(200);
    expect(detailJson.task.id).toBe("task-1");

    const planResponse = await agent.request("/tasks/task-1/plan", {
      method: "POST",
      headers: { Cookie: "token=test-token" },
    });
    const planJson = (await planResponse.json()) as {
      task: { status: string };
      planSteps: Array<unknown>;
      approvals: Array<unknown>;
    };
    expect(planResponse.status).toBe(200);
    expect(planJson.task.status).toBe("awaiting_approval");
    expect(planJson.planSteps).toHaveLength(3);
    expect(planJson.approvals).toHaveLength(1);

    const executeBlocked = await agent.request("/tasks/task-1/execute", {
      method: "POST",
      headers: { Cookie: "token=test-token" },
    });
    expect(executeBlocked.status).toBe(400);
    expect(await executeBlocked.text()).toBe("Task plan must be approved before execution.");

    const approvalResponse = await agent.request("/approvals/approval-1/respond", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: "token=test-token" },
      body: JSON.stringify({ status: "approved", response: { ok: true } }),
    });
    const approvalJson = (await approvalResponse.json()) as {
      task: { status: string };
      approvals: Array<{ status: string }>;
    };
    expect(approvalResponse.status).toBe(200);
    expect(approvalJson.task.status).toBe("draft");
    expect(approvalJson.approvals[0].status).toBe("approved");
  } finally {
    mock.restore();
  }
});
