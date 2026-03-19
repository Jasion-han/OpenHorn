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
      runs: runs.filter((item) => item.taskId === taskId).slice().reverse(),
      planSteps: planSteps.filter((item) => item.taskId === taskId),
      approvals: approvals.filter((item) => item.taskId === taskId).slice().reverse(),
      artifacts: artifacts.filter((item) => item.taskId === taskId).slice().reverse(),
      events: events.filter((item) => item.taskId === taskId),
    };
  };

  async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 1500) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      if (await check()) return true;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return false;
  }

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
    runAgentWithConfig: async function* (config: Record<string, unknown>) {
      const prompt = typeof config.prompt === "string" ? config.prompt : "";
      yield { type: "text", content: "Starting execution." };
      if (prompt.includes("Trigger tool approval")) {
        const canUseTool = config.canUseTool as
          | ((
              toolName: string,
              toolInput: Record<string, unknown>,
              options: Record<string, unknown>,
            ) => Promise<{ behavior: string }>)
          | undefined;
        if (canUseTool) {
          await canUseTool(
            "Bash",
            { command: "rm -rf /tmp/demo" },
            {
              signal: new AbortController().signal,
              toolUseID: "tool-use-1",
              decisionReason: "rm -rf is high risk",
            },
          );
        }
        yield { type: "text", content: "Resumed after approval." };
      }
    },
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
    updateAgentTask: async (_userId: string, taskId: string, input: Record<string, unknown>) => {
      const task = tasks.find((item) => item.id === taskId);
      if (!task) {
        throw new Error("Task not found");
      }
      if (task.status === "running" || task.status === "planning") {
        throw new Error("Cannot edit a task while it is planning or running");
      }
      task.goal = String(input.goal);
      if (typeof input.title === "string") {
        task.title = input.title;
      }
      task.status = "draft";
      task.updatedAt = new Date().toISOString();
      approvals.forEach((approval) => {
        if (
          approval.taskId === taskId &&
          approval.type === "plan_approval" &&
          (approval.status === "pending" || approval.status === "approved")
        ) {
          approval.status = "rejected";
          approval.response = { source: "task_goal_updated" };
          approval.respondedAt = new Date().toISOString();
          approval.updatedAt = new Date().toISOString();
        }
      });
      return task;
    },
    listAgentTaskEvents: async (_userId: string, taskId: string) =>
      events.filter((item) => item.taskId === taskId),
    listAgentArtifacts: async (_userId: string, taskId: string) =>
      artifacts.filter((item) => item.taskId === taskId),
    createAgentTask: async (_userId: string, input: Record<string, unknown>) => {
      const task = {
        id: `task-${tasks.length + 1}`,
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
    getLatestRunForTask: async (_userId: string, taskId: string, phase?: string) =>
      runs
        .filter((item) => item.taskId === taskId && (!phase || item.phase === phase))
        .slice()
        .reverse()[0] ?? null,
    updateAgentPlanStepStatuses: async (_userId: string, input: { steps: Array<{ id: string; status: string }> }) => {
      return input.steps
        .map((stepUpdate) => {
          const step = planSteps.find((item) => item.id === stepUpdate.id);
          if (!step) return null;
          step.status = stepUpdate.status;
          step.updatedAt = new Date().toISOString();
          return step;
        })
        .filter((step): step is Record<string, unknown> => Boolean(step));
    },
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

    const updateMissingGoal = await agent.request("/tasks/task-1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: "token=test-token" },
      body: JSON.stringify({ goal: "" }),
    });
    expect(updateMissingGoal.status).toBe(400);

    const updateResponse = await agent.request("/tasks/task-1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: "token=test-token" },
      body: JSON.stringify({ goal: "Ship the edited agent workbench goal." }),
    });
    const updateJson = (await updateResponse.json()) as {
      task: { goal: string; status: string };
      approvals: Array<{ status: string }>;
    };
    expect(updateResponse.status).toBe(200);
    expect(updateJson.task.goal).toBe("Ship the edited agent workbench goal.");
    expect(updateJson.task.status).toBe("draft");
    expect(updateJson.approvals[0].status).toBe("rejected");

    const executeAfterGoalEdit = await agent.request("/tasks/task-1/execute", {
      method: "POST",
      headers: { Cookie: "token=test-token" },
    });
    expect(executeAfterGoalEdit.status).toBe(400);
    expect(await executeAfterGoalEdit.text()).toBe("Task plan must be approved before execution.");

    const replanResponse = await agent.request("/tasks/task-1/plan", {
      method: "POST",
      headers: { Cookie: "token=test-token" },
    });
    const replanJson = (await replanResponse.json()) as {
      task: { status: string };
      planSteps: Array<{ title: string }>;
      approvals: Array<{ id: string; status: string }>;
    };
    expect(replanResponse.status).toBe(200);
    expect(replanJson.task.status).toBe("awaiting_approval");
    expect(replanJson.planSteps[1]?.title).toContain("Ship the edited agent workbench goal.");
    expect(replanJson.approvals[0].status).toBe("pending");

    const replanApprovalResponse = await agent.request(
      `/approvals/${replanJson.approvals[0]!.id}/respond`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: "token=test-token" },
        body: JSON.stringify({ status: "approved", response: { source: "replan" } }),
      },
    );
    expect(replanApprovalResponse.status).toBe(200);

    const retryBlocked = await agent.request("/tasks/task-1/retry", {
      method: "POST",
      headers: { Cookie: "token=test-token" },
    });
    expect(retryBlocked.status).toBe(400);
    expect(await retryBlocked.text()).toBe("Only failed, cancelled, or completed tasks can be retried.");

    const continueBlocked = await agent.request("/tasks/task-1/continue", {
      method: "POST",
      headers: { Cookie: "token=test-token" },
    });
    expect(continueBlocked.status).toBe(400);
    expect(await continueBlocked.text()).toBe("Only failed or completed tasks can be continued.");

    const task = tasks.find((item) => item.id === "task-1");
    expect(task).toBeTruthy();
    if (!task) {
      throw new Error("task-1 missing");
    }

    task.status = "failed";

    const retryResponse = await agent.request("/tasks/task-1/retry", {
      method: "POST",
      headers: { Cookie: "token=test-token" },
    });
    expect(retryResponse.status).toBe(200);
    expect(retryResponse.headers.get("content-type")).toContain("text/event-stream");
    await retryResponse.text();

    task.status = "completed";

    const continueResponse = await agent.request("/tasks/task-1/continue", {
      method: "POST",
      headers: { Cookie: "token=test-token" },
    });
    expect(continueResponse.status).toBe(200);
    expect(continueResponse.headers.get("content-type")).toContain("text/event-stream");
    await continueResponse.text();

    const createToolApprovalTask = await agent.request("/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: "token=test-token" },
      body: JSON.stringify({ title: "Tool approval", goal: "Trigger tool approval for risky bash." }),
    });
    const createToolApprovalJson = (await createToolApprovalTask.json()) as { task: { id: string } };
    expect(createToolApprovalTask.status).toBe(201);
    expect(createToolApprovalJson.task.id).toBe("task-2");

    const toolPlanResponse = await agent.request("/tasks/task-2/plan", {
      method: "POST",
      headers: { Cookie: "token=test-token" },
    });
    const toolPlanJson = (await toolPlanResponse.json()) as {
      approvals: Array<{ id: string }>;
    };
    expect(toolPlanResponse.status).toBe(200);

    const toolPlanApprovalResponse = await agent.request(
      `/approvals/${toolPlanJson.approvals[0]!.id}/respond`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: "token=test-token" },
        body: JSON.stringify({ status: "approved", response: { source: "test" } }),
      },
    );
    expect(toolPlanApprovalResponse.status).toBe(200);

    const toolExecuteResponse = await agent.request("/tasks/task-2/execute", {
      method: "POST",
      headers: { Cookie: "token=test-token" },
    });
    expect(toolExecuteResponse.status).toBe(200);

    const toolApprovalReady = await waitFor(async () => {
      const detailResponse = await agent.request("/tasks/task-2", {
        method: "GET",
        headers: { Cookie: "token=test-token" },
      });
      const detailJson = (await detailResponse.json()) as {
        task: { status: string };
        approvals: Array<{ id: string; type: string; status: string }>;
      };
      return (
        detailJson.task.status === "awaiting_approval" &&
        detailJson.approvals[0]?.type === "tool_approval" &&
        detailJson.approvals[0]?.status === "pending"
      );
    });
    expect(toolApprovalReady).toBe(true);

    const toolDetailResponse = await agent.request("/tasks/task-2", {
      method: "GET",
      headers: { Cookie: "token=test-token" },
    });
    const toolDetailJson = (await toolDetailResponse.json()) as {
      approvals: Array<{ id: string; type: string; status: string }>;
    };

    const toolApprovalResponse = await agent.request(
      `/approvals/${toolDetailJson.approvals[0]!.id}/respond`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: "token=test-token" },
        body: JSON.stringify({ status: "approved", response: { source: "tool-approval-test" } }),
      },
    );
    expect(toolApprovalResponse.status).toBe(200);

    await toolExecuteResponse.text();

    const finalToolDetailResponse = await agent.request("/tasks/task-2", {
      method: "GET",
      headers: { Cookie: "token=test-token" },
    });
    const finalToolDetailJson = (await finalToolDetailResponse.json()) as {
      task: { status: string };
      approvals: Array<{ type: string; status: string }>;
    };
    expect(finalToolDetailJson.task.status).toBe("completed");
    expect(finalToolDetailJson.approvals[0]?.type).toBe("tool_approval");
    expect(finalToolDetailJson.approvals[0]?.status).toBe("approved");
  } finally {
    mock.restore();
  }
});
