import { expect, test } from "bun:test";
import { createAgentRouter } from "./agent";

test("task routes cover create, list, detail, plan, approval, and execute preconditions", async () => {
  const tasks: Array<Record<string, unknown>> = [];
  const runs: Array<Record<string, unknown>> = [];
  const planSteps: Array<Record<string, unknown>> = [];
  const approvals: Array<Record<string, unknown>> = [];
  const events: Array<Record<string, unknown>> = [];
  const artifacts: Array<Record<string, unknown>> = [];

  const buildDetail = (taskId: string) => {
    const task = tasks.find((item) => item.id === taskId) ?? null;
    const runtimeEvent = events
      .filter((item) => item.taskId === taskId)
      .slice()
      .reverse()
      .find((item) => {
        if (item.type !== "execution_event") return false;
        if (!item.metadata || typeof item.metadata !== "object") return false;
        return (item.metadata as { source?: string }).source === "runtime_selection";
      });
    return {
      task,
      runs: runs.filter((item) => item.taskId === taskId).slice().reverse(),
      planSteps: planSteps.filter((item) => item.taskId === taskId),
      approvals: approvals.filter((item) => item.taskId === taskId).slice().reverse(),
      artifacts: artifacts.filter((item) => item.taskId === taskId).slice().reverse(),
      events: events.filter((item) => item.taskId === taskId),
      runtime:
        runtimeEvent && runtimeEvent.metadata && typeof runtimeEvent.metadata === "object"
          ? {
              modelId:
                typeof (runtimeEvent.metadata as { modelId?: string }).modelId === "string"
                  ? (runtimeEvent.metadata as { modelId: string }).modelId
                  : null,
              channelName:
                typeof (runtimeEvent.metadata as { channelName?: string }).channelName === "string"
                  ? (runtimeEvent.metadata as { channelName: string }).channelName
                  : null,
              source: "event",
            }
          : null,
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

  const agent = createAgentRouter({
    requireUserMiddleware: async (c, next) => {
      c.set("user", { id: "user-1" } as never);
      await next();
    },
    getResolvedChannelForConversation: async () => ({
      channel: { id: "channel-1", provider: "anthropic" },
      modelId: "claude-3-7-sonnet",
      apiKey: "test-key",
    }),
    resolveAgentRuntime: async () => ({
      success: true as const,
      resolvedChannel: {
        channel: { id: "channel-1", provider: "anthropic", name: "Test Channel" },
        modelId: "claude-3-7-sonnet",
        apiKey: "test-key",
      },
      compatibility: { success: true as const, mode: "claude_sdk" },
      fallbackUsed: false,
      attempts: [],
    }),
    getAgentCapabilityModeFromSuccessResult: () => "claude_sdk",
    buildAgentRuntimeContext: async (input: { prompt?: string }) => ({
      channelId: "channel-1",
      modelId: "claude-3-7-sonnet",
      globalSystemPrompt: undefined,
      liveSystemContext:
        input.prompt?.includes("联网搜索 OpenAI") ? "Injected live search context." : undefined,
      liveContext: input.prompt?.includes("联网搜索 OpenAI")
        ? {
            status: "live",
            route: "web_search",
            userLabel: "已使用实时搜索",
            source: { type: "web_search", provider: "tavily" },
            systemContext: "Injected live search context.",
            citations: [
              {
                title: "OpenAI API Docs",
                url: "https://platform.openai.com/docs/api-reference/responses",
                snippet:
                  "### Events Meetups Hackathon Support Forum Discord API Dashboard Responses API # Responses Overview OpenAI’s most advanced interface for generating model responses. Supports text and image inputs, and text outputs.",
              },
            ],
          }
        : undefined,
    }),
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
    createAgentStreamTimeoutGuard: () => ({
      markVisibleOutput() {},
      markActivity() {},
      cleanup() {},
    }),
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
        attachments: Array.isArray(input.attachments) ? input.attachments : [],
        complexity:
          input.complexity === "light" || input.complexity === "standard" || input.complexity === "deep"
            ? input.complexity
            : "standard",
        uxMode:
          input.uxMode === "direct" || input.uxMode === "compact" || input.uxMode === "full"
            ? input.uxMode
            : "full",
        requiresPlanApproval:
          typeof input.requiresPlanApproval === "boolean" ? input.requiresPlanApproval : true,
        autoStart: typeof input.autoStart === "boolean" ? input.autoStart : false,
        status: "draft",
        insight: null,
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
        toolName: input.toolName ?? null,
        toolInput: input.toolInput ?? null,
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
      for (let index = planSteps.length - 1; index >= 0; index -= 1) {
        if (planSteps[index]?.taskId === taskId) {
          planSteps.splice(index, 1);
        }
      }
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
    getLatestApprovalForTask: async (_userId: string, taskId: string, type?: string) =>
      approvals
        .filter((item) => item.taskId === taskId && (!type || item.type === type))
        .slice()
        .reverse()[0] ?? null,
    getLatestRunForTask: async (_userId: string, taskId: string, phase?: string) =>
      runs
        .filter((item) => item.taskId === taskId && (!phase || item.phase === phase))
        .slice()
        .reverse()[0] ?? null,
    updateAgentPlanStepStatuses: async (
      _userId: string,
      input: { steps: Array<{ id: string; status: string }> },
    ) => {
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
  } as any);

  const missingGoal = await agent.request("/tasks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "Missing goal" }),
  });
  expect(missingGoal.status).toBe(400);

  const createResponse = await agent.request("/tasks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "Task", goal: "Ship the agent workbench." }),
  });
  const createJson = (await createResponse.json()) as { task: { id: string } };
  expect(createResponse.status).toBe(201);
  expect(createJson.task.id).toBe("task-1");

  const listResponse = await agent.request("/tasks", { method: "GET" });
  const listJson = (await listResponse.json()) as { tasks: Array<{ id: string }> };
  expect(listResponse.status).toBe(200);
  expect(listJson.tasks).toHaveLength(1);

  const detailResponse = await agent.request("/tasks/task-1", { method: "GET" });
  const detailJson = (await detailResponse.json()) as { task: { id: string } };
  expect(detailResponse.status).toBe(200);
  expect(detailJson.task.id).toBe("task-1");

  const planResponse = await agent.request("/tasks/task-1/plan", { method: "POST" });
  const planJson = (await planResponse.json()) as {
    task: { status: string };
    planSteps: Array<unknown>;
    approvals: Array<unknown>;
  };
  expect(planResponse.status).toBe(200);
  expect(planJson.task.status).toBe("awaiting_approval");
  expect(planJson.planSteps).toHaveLength(3);
  expect(planJson.approvals).toHaveLength(1);

  const executeBlocked = await agent.request("/tasks/task-1/execute", { method: "POST" });
  expect(executeBlocked.status).toBe(400);
  expect(await executeBlocked.text()).toBe("Task plan must be approved before execution.");

  const approvalResponse = await agent.request("/approvals/approval-1/respond", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status: "approved", response: { ok: true } }),
  });
  const approvalJson = (await approvalResponse.json()) as {
    task: { status: string };
    approvals: Array<{ status: string }>;
  };
  expect(approvalResponse.status).toBe(200);
  expect(approvalJson.task.status).toBe("draft");
  expect(approvalJson.approvals[0]?.status).toBe("approved");

  const updateMissingGoal = await agent.request("/tasks/task-1", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ goal: "" }),
  });
  expect(updateMissingGoal.status).toBe(400);

  const updateResponse = await agent.request("/tasks/task-1", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ goal: "Ship the edited agent workbench goal." }),
  });
  const updateJson = (await updateResponse.json()) as {
    task: { goal: string; status: string };
    approvals: Array<{ status: string }>;
  };
  expect(updateResponse.status).toBe(200);
  expect(updateJson.task.goal).toBe("Ship the edited agent workbench goal.");
  expect(updateJson.task.status).toBe("draft");
  expect(updateJson.approvals[0]?.status).toBe("rejected");

  const executeAfterGoalEdit = await agent.request("/tasks/task-1/execute", { method: "POST" });
  expect(executeAfterGoalEdit.status).toBe(400);
  expect(await executeAfterGoalEdit.text()).toBe("Task plan must be approved before execution.");

  const replanResponse = await agent.request("/tasks/task-1/plan", { method: "POST" });
  const replanJson = (await replanResponse.json()) as {
    task: { status: string };
    planSteps: Array<{ title: string }>;
    approvals: Array<{ id: string; status: string }>;
  };
  expect(replanResponse.status).toBe(200);
  expect(replanJson.task.status).toBe("awaiting_approval");
  expect(replanJson.planSteps[1]?.title).toContain("Ship the edited agent workbench goal.");
  expect(replanJson.approvals[0]?.status).toBe("pending");

  const replanApprovalResponse = await agent.request(
    `/approvals/${replanJson.approvals[0]!.id}/respond`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "approved", response: { source: "replan" } }),
    },
  );
  expect(replanApprovalResponse.status).toBe(200);

  const retryBlocked = await agent.request("/tasks/task-1/retry", { method: "POST" });
  expect(retryBlocked.status).toBe(400);
  expect(await retryBlocked.text()).toBe(
    "Only failed, cancelled, or completed tasks can be retried.",
  );

  const continueBlocked = await agent.request("/tasks/task-1/continue", { method: "POST" });
  expect(continueBlocked.status).toBe(400);
  expect(await continueBlocked.text()).toBe("Only failed or completed tasks can be continued.");

  const task = tasks.find((item) => item.id === "task-1");
  expect(task).toBeTruthy();
  if (!task) {
    throw new Error("task-1 missing");
  }

  task.status = "failed";

  const retryResponse = await agent.request("/tasks/task-1/retry", { method: "POST" });
  expect(retryResponse.status).toBe(200);
  expect(retryResponse.headers.get("content-type")).toContain("text/event-stream");
  await retryResponse.text();

  task.status = "completed";

  const continueResponse = await agent.request("/tasks/task-1/continue", { method: "POST" });
  expect(continueResponse.status).toBe(200);
  expect(continueResponse.headers.get("content-type")).toContain("text/event-stream");
  await continueResponse.text();

  const createCompactTask = await agent.request("/tasks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: "Compact auto task",
      goal: "Run without requiring plan approval.",
      requiresPlanApproval: false,
      autoStart: true,
    }),
  });
  const createCompactJson = (await createCompactTask.json()) as { task: { id: string } };
  expect(createCompactTask.status).toBe(201);

  const compactPlanResponse = await agent.request(`/tasks/${createCompactJson.task.id}/plan`, {
    method: "POST",
  });
  const compactPlanJson = (await compactPlanResponse.json()) as {
    task: { status: string };
    planSteps: Array<{ title: string }>;
    approvals: Array<unknown>;
  };
  expect(compactPlanResponse.status).toBe(200);
  expect(compactPlanJson.task.status).toBe("draft");
  expect(compactPlanJson.planSteps).toHaveLength(3);
  expect(compactPlanJson.approvals).toHaveLength(0);

  const compactExecuteResponse = await agent.request(`/tasks/${createCompactJson.task.id}/execute`, {
    method: "POST",
  });
  expect(compactExecuteResponse.status).toBe(200);
  expect(compactExecuteResponse.headers.get("content-type")).toContain("text/event-stream");
  await compactExecuteResponse.text();

  const createToolApprovalTask = await agent.request("/tasks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "Tool approval", goal: "Trigger tool approval for risky bash." }),
  });
  const createToolApprovalJson = (await createToolApprovalTask.json()) as { task: { id: string } };
  expect(createToolApprovalTask.status).toBe(201);
  expect(createToolApprovalJson.task.id).toBe("task-3");

  const toolPlanResponse = await agent.request(`/tasks/${createToolApprovalJson.task.id}/plan`, {
    method: "POST",
  });
  const toolPlanJson = (await toolPlanResponse.json()) as { approvals: Array<{ id: string }> };
  expect(toolPlanResponse.status).toBe(200);

  const toolPlanApprovalResponse = await agent.request(
    `/approvals/${toolPlanJson.approvals[0]!.id}/respond`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "approved", response: { source: "test" } }),
    },
  );
  expect(toolPlanApprovalResponse.status).toBe(200);

  const toolExecuteResponse = await agent.request(`/tasks/${createToolApprovalJson.task.id}/execute`, {
    method: "POST",
  });
  expect(toolExecuteResponse.status).toBe(200);
  const toolExecuteTextPromise = toolExecuteResponse.text();

  const toolApprovalReady = await waitFor(async () => {
    const detailResponse = await agent.request(`/tasks/${createToolApprovalJson.task.id}`, {
      method: "GET",
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

  const toolDetailResponse = await agent.request(`/tasks/${createToolApprovalJson.task.id}`, {
    method: "GET",
  });
  const toolDetailJson = (await toolDetailResponse.json()) as {
    approvals: Array<{ id: string; type: string; status: string }>;
  };

  const toolApprovalResponse = await agent.request(
    `/approvals/${toolDetailJson.approvals[0]!.id}/respond`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "approved", response: { source: "tool-approval-test" } }),
    },
  );
  expect(toolApprovalResponse.status).toBe(200);

  await toolExecuteTextPromise;

  const finalToolDetailResponse = await agent.request(`/tasks/${createToolApprovalJson.task.id}`, {
    method: "GET",
  });
  const finalToolDetailJson = (await finalToolDetailResponse.json()) as {
    task: { status: string };
    approvals: Array<{ type: string; status: string }>;
    runtime?: { modelId?: string | null; channelName?: string | null; source?: string | null } | null;
  };
  expect(finalToolDetailJson.task.status).toBe("completed");
  expect(finalToolDetailJson.approvals[0]?.type).toBe("tool_approval");
  expect(finalToolDetailJson.approvals[0]?.status).toBe("approved");
  expect(finalToolDetailJson.runtime?.modelId).toBe("claude-3-7-sonnet");
  expect(finalToolDetailJson.runtime?.channelName).toBe("Test Channel");
  expect(finalToolDetailJson.runtime?.source).toBe("event");

  expect(
    events.some(
      (item) =>
        item.type === "execution_event" &&
        typeof item.metadata === "object" &&
        item.metadata !== null &&
        (item.metadata as { eventType?: string }).eventType === "text",
    ),
  ).toBe(true);
  expect(
    artifacts.some(
      (item) =>
        item.type === "final_result" &&
        typeof item.content === "string" &&
        item.content.includes("Starting execution."),
    ),
  ).toBe(true);

  const createWebSearchTask = await agent.request("/tasks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: "Web search",
      goal: "请联网搜索 OpenAI 官方网站并总结 Responses API 标题。",
    }),
  });
  const createWebSearchJson = (await createWebSearchTask.json()) as { task: { id: string } };
  expect(createWebSearchTask.status).toBe(201);
  expect(createWebSearchJson.task.id).toBe("task-4");

  const webPlanResponse = await agent.request(`/tasks/${createWebSearchJson.task.id}/plan`, {
    method: "POST",
  });
  const webPlanJson = (await webPlanResponse.json()) as { approvals: Array<{ id: string }> };
  expect(webPlanResponse.status).toBe(200);

  const webPlanApprovalResponse = await agent.request(
    `/approvals/${webPlanJson.approvals[0]!.id}/respond`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "approved", response: { source: "web-search-test" } }),
    },
  );
  expect(webPlanApprovalResponse.status).toBe(200);

  const webExecuteResponse = await agent.request(`/tasks/${createWebSearchJson.task.id}/execute`, {
    method: "POST",
  });
  expect(webExecuteResponse.status).toBe(200);
  await webExecuteResponse.text();

  const webDetailResponse = await agent.request(`/tasks/${createWebSearchJson.task.id}`, {
    method: "GET",
  });
  const webDetailJson = (await webDetailResponse.json()) as {
    events: Array<{
      type: string;
      toolName?: string | null;
      metadata?: { eventType?: string; source?: string } | null;
      toolInput?: { query?: string } | null;
    }>;
    artifacts: Array<{
      type: string;
      content?: string | null;
      metadata?: { citations?: Array<{ title: string; url: string }> } | null;
    }>;
  };
  expect(
    webDetailJson.events.some(
      (event) =>
        event.type === "execution_event" &&
        event.toolName === "web_search" &&
        event.metadata?.eventType === "tool_start" &&
        event.metadata?.source === "live_context",
    ),
  ).toBe(true);
  expect(
    webDetailJson.events.some(
      (event) =>
        event.type === "execution_event" &&
        event.toolName === "web_search" &&
        event.metadata?.eventType === "tool_result" &&
        event.metadata?.source === "live_context",
    ),
  ).toBe(true);
  const webFinalResult = webDetailJson.artifacts.find((artifact) => artifact.type === "final_result");
  expect(webFinalResult?.content).toContain("[1]");
  expect(webFinalResult?.metadata?.citations?.[0]?.title).toBe("OpenAI API Docs");
  expect(webFinalResult?.metadata?.citations?.[0]?.url).toBe(
    "https://platform.openai.com/docs/api-reference/responses",
  );
  expect(webFinalResult?.content).toContain(
    "一句总结：OpenAI’s most advanced interface for generating model responses.",
  );
  expect(webFinalResult?.content).not.toContain("### Events Meetups");
});
