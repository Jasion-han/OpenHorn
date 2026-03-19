import { Hono } from "hono";
import {
  buildAgentRuntimeContext,
  createAgentSession,
  deleteAgentEvent,
  deleteAgentSession,
  getAgentEvents,
  getAgentSessionById,
  getAgentSessions,
  renameAgentSession,
  runAgent,
  runAgentWithConfig,
  updateAgentSessionChannel,
  updateAgentSessionStatus,
} from "../services/agentService";
import {
  createAgentApprovalRequest,
  createAgentArtifact,
  createAgentRun,
  createAgentTask,
  createAgentTaskEvent,
  getAgentTaskById,
  getAgentTaskDetail,
  getLatestApprovalForTask,
  getLatestRunForTask,
  listAgentArtifacts,
  listAgentTaskEvents,
  listAgentTasks,
  respondToAgentApproval,
  setAgentPlanSteps,
  updateAgentPlanStepStatuses,
  updateAgentTask,
  updateAgentRunStatus,
  updateAgentTaskStatus,
} from "../services/agentTaskService";
import { generateAutoTitle } from "../services/autoTitleService";
import { checkChannelAgentCompatibility } from "../services/channelAgentCheckService";
import { getResolvedChannelForConversation } from "../services/channelService";
import { requireUser, type UserEnv } from "../utils/requestUser";
import { createSseStream } from "../utils/sse";
import { isRecord } from "../utils/typeGuards";

const agent = new Hono<UserEnv>();

agent.use("*", requireUser);

function buildPlanFromGoal(goal: string) {
  const normalized = goal.trim().replace(/\s+/g, " ");
  const executionTitle =
    normalized.length > 72 ? `${normalized.slice(0, 69).trim()}...` : normalized;

  return [
    {
      title: "Inspect task scope and available context",
      description: "Review the goal, attachments, and constraints before execution.",
      status: "ready" as const,
    },
    {
      title: executionTitle || "Execute the requested task",
      description: "Carry out the task using the approved plan and required tools.",
      status: "pending" as const,
    },
    {
      title: "Verify outcome and summarize results",
      description: "Validate the output, note risks, and produce a final result artifact.",
      status: "pending" as const,
    },
  ];
}

function buildExecutionPrompt(goal: string, planSteps: Array<{ title: string; description?: string | null }>) {
  const renderedPlan = planSteps
    .map((step, index) =>
      [`${index + 1}. ${step.title}`, step.description?.trim()].filter(Boolean).join("\n"),
    )
    .join("\n\n");

  return [`Approved task goal:`, goal.trim(), `Approved execution plan:`, renderedPlan]
    .filter(Boolean)
    .join("\n\n");
}

function summarizeExecution(params: {
  finalText: string;
  toolStarts: number;
  toolResults: number;
  hadError: boolean;
}) {
  const parts = [
    params.hadError ? "Execution ended with an error." : "Execution completed.",
    `Tool starts: ${params.toolStarts}.`,
    `Tool results: ${params.toolResults}.`,
    `Final text length: ${params.finalText.trim().length}.`,
  ];
  return parts.join(" ");
}

function buildExecutionModeContext(
  params: {
    mode: "execute" | "retry" | "continue";
    previousRun?: { summary: string | null; error: string | null } | null;
    previousFinalResult?: string | null;
    resumeStepTitle?: string | null;
    completedStepTitles?: string[];
  },
) {
  if (params.mode === "execute") {
    return null;
  }

  const parts: string[] = [];
  if (params.mode === "retry") {
    parts.push("Execution mode: retry the task from scratch.");
    parts.push("Ignore any incomplete prior progress and execute the approved plan again from the beginning.");
  } else {
    parts.push("Execution mode: continue from the previous attempt when useful.");
    if ((params.completedStepTitles?.length ?? 0) > 0) {
      parts.push(
        `Completed plan steps from the previous attempt:\n${params.completedStepTitles!.map((title) => `- ${title}`).join("\n")}`,
      );
    }
    if (params.resumeStepTitle) {
      parts.push(`Resume focus: continue from the next unfinished plan step.\n${params.resumeStepTitle}`);
    } else {
      parts.push("All approved plan steps were previously completed. Continue by refining or extending the latest result when useful.");
    }
  }

  const previousSummary =
    params.previousRun?.summary?.trim() || params.previousRun?.error?.trim() || "";
  if (previousSummary) {
    parts.push(`Previous attempt summary:\n${previousSummary}`);
  }

  const previousFinalResult = params.previousFinalResult?.trim() || "";
  if (previousFinalResult) {
    parts.push(`Previous final result draft:\n${previousFinalResult.slice(0, 2500)}`);
  }

  return parts.join("\n\n");
}

type ExecutionPlanStepStatus = "pending" | "ready" | "running" | "completed" | "failed";

type ExecutionPlanStepShape = {
  id: string;
  status: ExecutionPlanStepStatus;
};

function getContinueResumeStepIndex(
  planSteps: Array<{ status: ExecutionPlanStepStatus }>,
) {
  const firstNonCompletedIndex = planSteps.findIndex((step, index) => index > 0 && step.status !== "completed");
  if (firstNonCompletedIndex >= 0) {
    return firstNonCompletedIndex;
  }
  if (planSteps.length === 0) {
    return -1;
  }
  return planSteps.length > 1 ? planSteps.length - 1 : 0;
}

function buildExecutionStepStartStatuses(
  mode: "execute" | "retry" | "continue",
  planSteps: Array<{ id: string; status: ExecutionPlanStepStatus }>,
): ExecutionPlanStepShape[] {
  if (planSteps.length === 0) {
    return [];
  }

  const activeIndex =
    mode === "continue"
      ? getContinueResumeStepIndex(planSteps)
      : planSteps.length > 1
        ? 1
        : 0;

  return planSteps.map((step, index) => ({
    id: step.id,
    status:
      index < activeIndex
        ? "completed"
        : index === activeIndex
          ? "running"
          : "pending",
  }));
}

function buildExecutionFailureStatuses(
  planSteps: Array<{ id: string; status: ExecutionPlanStepStatus }>,
): ExecutionPlanStepShape[] {
  const activeIndex = planSteps.findIndex((step) => step.status === "running");
  if (activeIndex < 0) {
    return [];
  }
  return planSteps.map((step, index) => ({
    id: step.id,
    status:
      index < activeIndex
        ? "completed"
        : index === activeIndex
          ? "failed"
          : "pending",
  }));
}

function buildExecutionSuccessStatuses(
  planSteps: Array<{ id: string }>,
): ExecutionPlanStepShape[] {
  return planSteps.map((step) => ({
    id: step.id,
    status: "completed" as const,
  }));
}

async function syncExecutionPlanSteps(params: {
  userId: string;
  taskId: string;
  executionRunId: string;
  planSteps: Array<{
    id: string;
    orderIndex: number;
    title: string;
    status: "pending" | "ready" | "running" | "completed" | "failed";
  }>;
  nextStatuses: Array<{
    id: string;
    status: "pending" | "ready" | "running" | "completed" | "failed";
  }>;
  send: (event: Record<string, unknown>) => void;
}) {
  const updates = params.nextStatuses.filter((nextStep) => {
    const current = params.planSteps.find((step) => step.id === nextStep.id);
    return current && current.status !== nextStep.status;
  });
  if (updates.length === 0) {
    return;
  }

  const updatedSteps = await updateAgentPlanStepStatuses(params.userId, { steps: updates });
  for (const updatedStep of updatedSteps) {
    const local = params.planSteps.find((step) => step.id === updatedStep.id);
    if (local) {
      local.status = updatedStep.status;
    }
    await createAgentTaskEvent(params.userId, params.taskId, params.executionRunId, {
      type: "plan_step",
      content: updatedStep.title,
      metadata: {
        stepId: updatedStep.id,
        orderIndex: updatedStep.orderIndex,
        status: updatedStep.status,
        source: "execution",
      },
    });
    params.send({
      type: "plan_step",
      taskId: params.taskId,
      runId: params.executionRunId,
      stepId: updatedStep.id,
      orderIndex: updatedStep.orderIndex,
      title: updatedStep.title,
      status: updatedStep.status,
    });
  }
}

async function resolveTaskExecutionContext(
  userId: string,
  taskId: string,
  mode: "execute" | "retry" | "continue",
) {
  const task = await getAgentTaskById(userId, taskId);
  if (!task) {
    return { error: "Task not found", status: 404 as const };
  }

  const latestApproval = await getLatestApprovalForTask(userId, taskId, "plan_approval");
  if (!latestApproval || latestApproval.status !== "approved") {
    return { error: "Task plan must be approved before execution.", status: 400 as const };
  }

  const resolvedChannel = await getResolvedChannelForConversation(userId, {
    channelId: task.channelId,
    modelId: task.modelId,
  });
  const provider = resolvedChannel?.channel?.provider;
  if (!provider) {
    return { error: "未配置可用的默认渠道/默认模型。请先在设置中完成配置。", status: 400 as const };
  }
  if (provider !== "anthropic") {
    return {
      error: `Agent 模式目前仅支持 Anthropic(Claude Agent SDK)。当前 Provider: ${provider}。请切换到 Anthropic 渠道后重试。`,
      status: 400 as const,
    };
  }

  const compatibility = await checkChannelAgentCompatibility(
    userId,
    resolvedChannel.channel.id,
    resolvedChannel.modelId,
  );
  if (compatibility.success === false) {
    return { error: compatibility.error, status: 400 as const };
  }

  const detail = await getAgentTaskDetail(userId, taskId);
  const approvedPlanSteps = detail.planSteps
    .filter((step) => step.runId === latestApproval.runId)
    .sort((left, right) => left.orderIndex - right.orderIndex);

  if (mode === "retry" && !["failed", "cancelled", "completed"].includes(task.status)) {
    return { error: "Only failed, cancelled, or completed tasks can be retried.", status: 400 as const };
  }

  if (mode === "continue" && !["failed", "completed"].includes(task.status)) {
    return { error: "Only failed or completed tasks can be continued.", status: 400 as const };
  }

  const previousExecutionRun =
    mode === "execute" ? null : await getLatestRunForTask(userId, taskId, "execution");

  const previousFinalResult =
    previousExecutionRun
      ? detail.artifacts.find(
          (artifact) => artifact.runId === previousExecutionRun.id && artifact.type === "final_result",
        )?.content ?? null
      : null;
  const continueResumeIndex = getContinueResumeStepIndex(approvedPlanSteps);
  const hasUnfinishedContinueStep =
    mode === "continue" &&
    approvedPlanSteps.some((step, index) => index > 0 && step.status !== "completed");

  const taskModeContext = buildExecutionModeContext({
    mode,
    previousRun: previousExecutionRun,
    previousFinalResult,
    resumeStepTitle:
      mode === "continue" && hasUnfinishedContinueStep
        ? approvedPlanSteps[continueResumeIndex]?.title ?? null
        : null,
    completedStepTitles:
      mode === "continue"
        ? approvedPlanSteps.filter((step) => step.status === "completed").map((step) => step.title)
        : [],
  });
  const executionPrompt = [taskModeContext, buildExecutionPrompt(task.goal, approvedPlanSteps)]
    .filter((value): value is string => Boolean(value))
    .join("\n\n");

  return {
    task,
    approvedPlanSteps,
    executionPrompt,
  };
}

async function createTaskExecutionResponse(
  userId: string,
  taskId: string,
  mode: "execute" | "retry" | "continue",
) {
  const resolved = await resolveTaskExecutionContext(userId, taskId, mode);
  if ("error" in resolved) {
    return new Response(resolved.error, { status: resolved.status });
  }

  const { task, approvedPlanSteps, executionPrompt } = resolved;
  const attachmentIds = task.attachments
    .map((attachment) => attachment.id)
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0);

  const stream = createSseStream(async (send, ctx) => {
    const run = await createAgentRun(userId, taskId, {
      phase: "execution",
      status: "running",
      startedAt: new Date(),
    });

    let finalText = "";
    let toolStarts = 0;
    let toolResults = 0;
    let hadError = false;
    let errorText: string | null = null;

    await updateAgentTaskStatus(userId, taskId, "running");
    await createAgentTaskEvent(userId, taskId, run.id, {
      type: "task_status",
      content: "Task execution started.",
      metadata: { status: "running", mode },
    });
    send({ type: "task_status", taskId, runId: run.id, status: "running" });
    await syncExecutionPlanSteps({
      userId,
      taskId,
      executionRunId: run.id,
      planSteps: approvedPlanSteps,
      nextStatuses: buildExecutionStepStartStatuses(mode, approvedPlanSteps),
      send,
    });

    const runtimeContext = await buildAgentRuntimeContext({
      userId,
      prompt: executionPrompt,
      channelId: task.channelId,
      modelId: task.modelId,
    });

    try {
      for await (const event of runAgentWithConfig({
        userId,
        prompt: executionPrompt,
        attachmentIds,
        channelId: runtimeContext.channelId,
        modelId: runtimeContext.modelId,
        globalSystemPrompt: runtimeContext.globalSystemPrompt,
        liveSystemContext: runtimeContext.liveSystemContext,
        abortController: ctx.abortController,
      })) {
        if (event.type === "meta" || event.type === "done" || event.type === "user") {
          continue;
        }

        if (event.type === "text") {
          finalText += event.content ?? "";
          await createAgentTaskEvent(userId, taskId, run.id, {
            type: "execution_event",
            content: event.content ?? null,
            metadata: { eventType: "text" },
          });
          send({
            type: "execution_event",
            taskId,
            runId: run.id,
            eventType: "text",
            content: event.content ?? "",
          });
          continue;
        }

        if (event.type === "tool_start") {
          toolStarts += 1;
          await createAgentTaskEvent(userId, taskId, run.id, {
            type: "execution_event",
            content: event.content ?? null,
            toolName: event.toolName ?? null,
            toolInput: event.toolInput,
            metadata: { eventType: "tool_start" },
          });
          send({
            type: "execution_event",
            taskId,
            runId: run.id,
            eventType: "tool_start",
            toolName: event.toolName,
            toolInput: event.toolInput,
            content: event.content,
          });
          continue;
        }

        if (event.type === "tool_result") {
          toolResults += 1;
          await createAgentTaskEvent(userId, taskId, run.id, {
            type: "execution_event",
            content: event.content ?? null,
            toolName: event.toolName ?? null,
            metadata: { eventType: "tool_result" },
          });
          send({
            type: "execution_event",
            taskId,
            runId: run.id,
            eventType: "tool_result",
            toolName: event.toolName,
            content: event.content,
          });
          continue;
        }

        if (event.type === "error") {
          hadError = true;
          errorText = event.content ?? "Agent error";
          await createAgentTaskEvent(userId, taskId, run.id, {
            type: "error",
            content: errorText,
          });
          send({
            type: "error",
            taskId,
            runId: run.id,
            content: errorText,
          });
        }
      }

      const executionSummary = summarizeExecution({
        finalText,
        toolStarts,
        toolResults,
        hadError,
      });

      await createAgentArtifact(userId, taskId, run.id, {
        type: "execution_summary",
        title: "Execution summary",
        content: executionSummary,
        metadata: {
          hadError,
          toolStarts,
          toolResults,
        },
      });
      send({
        type: "artifact_created",
        taskId,
        runId: run.id,
        artifactType: "execution_summary",
      });

      if (finalText.trim()) {
        await createAgentArtifact(userId, taskId, run.id, {
          type: "final_result",
          title: "Final result",
          content: finalText.trim(),
        });
        send({
          type: "artifact_created",
          taskId,
          runId: run.id,
          artifactType: "final_result",
        });
        send({
          type: "final_result",
          taskId,
          runId: run.id,
          content: finalText.trim(),
        });
      }

      if (hadError) {
        await syncExecutionPlanSteps({
          userId,
          taskId,
          executionRunId: run.id,
          planSteps: approvedPlanSteps,
          nextStatuses: buildExecutionFailureStatuses(approvedPlanSteps),
          send,
        });
        await updateAgentRunStatus(userId, run.id, "failed", {
          summary: executionSummary,
          error: errorText,
          completedAt: new Date(),
        });
        await updateAgentTaskStatus(userId, taskId, "failed");
        await createAgentTaskEvent(userId, taskId, run.id, {
          type: "task_status",
          content: "Task execution failed.",
          metadata: { status: "failed" },
        });
        send({ type: "task_status", taskId, runId: run.id, status: "failed" });
      } else {
        await syncExecutionPlanSteps({
          userId,
          taskId,
          executionRunId: run.id,
          planSteps: approvedPlanSteps,
          nextStatuses: buildExecutionSuccessStatuses(approvedPlanSteps),
          send,
        });
        await updateAgentRunStatus(userId, run.id, "completed", {
          summary: executionSummary,
          completedAt: new Date(),
        });
        await updateAgentTaskStatus(userId, taskId, "completed");
        await createAgentTaskEvent(userId, taskId, run.id, {
          type: "task_status",
          content: "Task execution completed.",
          metadata: { status: "completed" },
        });
        send({ type: "task_status", taskId, runId: run.id, status: "completed" });
      }

      send({ type: "done", taskId, runId: run.id });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Task execution failed";
      await syncExecutionPlanSteps({
        userId,
        taskId,
        executionRunId: run.id,
        planSteps: approvedPlanSteps,
        nextStatuses: buildExecutionFailureStatuses(approvedPlanSteps),
        send,
      }).catch(() => undefined);
      await updateAgentRunStatus(userId, run.id, "failed", {
        summary: message,
        error: message,
        completedAt: new Date(),
      }).catch(() => undefined);
      await updateAgentTaskStatus(userId, taskId, "failed").catch(() => undefined);
      await createAgentTaskEvent(userId, taskId, run.id, {
        type: "error",
        content: message,
      }).catch(() => undefined);
      send({ type: "error", taskId, runId: run.id, content: message });
    }
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

agent.get("/tasks", async (c) => {
  const user = c.get("user");
  const tasks = await listAgentTasks(user.id);
  return c.json({ tasks });
});

agent.get("/tasks/:id", async (c) => {
  const user = c.get("user");
  const taskId = c.req.param("id");
  const task = await getAgentTaskById(user.id, taskId);
  if (!task) {
    return c.json({ error: "Task not found" }, 404);
  }
  const detail = await getAgentTaskDetail(user.id, taskId);
  return c.json(detail);
});

agent.patch("/tasks/:id", async (c) => {
  const user = c.get("user");
  const taskId = c.req.param("id");
  const task = await getAgentTaskById(user.id, taskId);
  if (!task) {
    return c.json({ error: "Task not found" }, 404);
  }

  const body = (await c.req.json().catch(() => null)) as unknown;
  if (!isRecord(body) || typeof body.goal !== "string" || !body.goal.trim()) {
    return c.json({ error: "goal is required" }, 400);
  }

  try {
    await updateAgentTask(user.id, taskId, {
      goal: body.goal,
      title: typeof body.title === "string" ? body.title : undefined,
    });
    const detail = await getAgentTaskDetail(user.id, taskId);
    return c.json(detail);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to update task";
    const status = message === "Task not found" ? 404 : 400;
    return c.json({ error: message }, status);
  }
});

agent.get("/tasks/:id/events", async (c) => {
  const user = c.get("user");
  const taskId = c.req.param("id");
  const task = await getAgentTaskById(user.id, taskId);
  if (!task) {
    return c.json({ error: "Task not found" }, 404);
  }
  const events = await listAgentTaskEvents(user.id, taskId);
  return c.json({ events });
});

agent.get("/tasks/:id/artifacts", async (c) => {
  const user = c.get("user");
  const taskId = c.req.param("id");
  const task = await getAgentTaskById(user.id, taskId);
  if (!task) {
    return c.json({ error: "Task not found" }, 404);
  }
  const artifacts = await listAgentArtifacts(user.id, taskId);
  return c.json({ artifacts });
});

agent.post("/tasks", async (c) => {
  const user = c.get("user");
  const body = (await c.req.json().catch(() => null)) as unknown;
  if (!isRecord(body) || typeof body.goal !== "string" || !body.goal.trim()) {
    return c.json({ error: "goal is required" }, 400);
  }

  const attachments = Array.isArray(body.attachments)
    ? body.attachments.filter((item): item is Record<string, unknown> => isRecord(item)).map((item) => ({
        id: typeof item.id === "string" ? item.id : undefined,
        fileName: typeof item.fileName === "string" ? item.fileName : "attachment",
        fileType: typeof item.fileType === "string" ? item.fileType : undefined,
        fileSize: typeof item.fileSize === "number" ? item.fileSize : undefined,
      }))
    : [];

  try {
    const task = await createAgentTask(user.id, {
      conversationId: typeof body.conversationId === "string" ? body.conversationId : null,
      channelId: typeof body.channelId === "string" ? body.channelId : null,
      modelId: typeof body.modelId === "string" ? body.modelId : null,
      title: typeof body.title === "string" ? body.title : null,
      goal: body.goal,
      attachments,
    });
    return c.json({ task }, 201);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Failed to create task" }, 400);
  }
});

agent.post("/tasks/:id/plan", async (c) => {
  const user = c.get("user");
  const taskId = c.req.param("id");
  const task = await getAgentTaskById(user.id, taskId);
  if (!task) {
    return c.json({ error: "Task not found" }, 404);
  }

  try {
    await updateAgentTaskStatus(user.id, taskId, "planning");
    const run = await createAgentRun(user.id, taskId, {
      phase: "planning",
      status: "running",
      startedAt: new Date(),
    });
    await createAgentTaskEvent(user.id, taskId, run.id, {
      type: "task_status",
      content: "Task entered planning.",
      metadata: { status: "planning" },
    });

    const planSteps = await setAgentPlanSteps(user.id, taskId, run.id, {
      steps: buildPlanFromGoal(task.goal),
    });

    for (const step of planSteps) {
      await createAgentTaskEvent(user.id, taskId, run.id, {
        type: "plan_step",
        content: step.title,
        metadata: {
          orderIndex: step.orderIndex,
          description: step.description,
          status: step.status,
        },
      });
    }

    const approval = await createAgentApprovalRequest(user.id, taskId, run.id, {
      type: "plan_approval",
      title: "Approve task execution",
      description: "Review the generated plan before the agent starts executing it.",
      payload: {
        planStepIds: planSteps.map((step) => step.id),
        planStepCount: planSteps.length,
      },
    });

    await createAgentTaskEvent(user.id, taskId, run.id, {
      type: "approval_requested",
      content: approval.title,
      metadata: { approvalId: approval.id, approvalType: approval.type },
    });

    await updateAgentRunStatus(user.id, run.id, "awaiting_approval");
    await updateAgentTaskStatus(user.id, taskId, "awaiting_approval");
    await createAgentTaskEvent(user.id, taskId, run.id, {
      type: "task_status",
      content: "Task is awaiting approval.",
      metadata: { status: "awaiting_approval" },
    });

    const detail = await getAgentTaskDetail(user.id, taskId);
    return c.json(detail);
  } catch (error) {
    await updateAgentTaskStatus(user.id, taskId, "failed").catch(() => undefined);
    return c.json({ error: error instanceof Error ? error.message : "Failed to create plan" }, 400);
  }
});

agent.post("/approvals/:id/respond", async (c) => {
  const user = c.get("user");
  const approvalId = c.req.param("id");
  const body = (await c.req.json().catch(() => null)) as unknown;
  if (!isRecord(body) || (body.status !== "approved" && body.status !== "rejected")) {
    return c.json({ error: "status must be approved or rejected" }, 400);
  }

  try {
    const approval = await respondToAgentApproval(user.id, approvalId, {
      status: body.status,
      response: isRecord(body.response) || Array.isArray(body.response) ? body.response : body.response,
    });

    const nextStatus =
      approval.type === "tool_approval" && approval.status === "approved"
        ? "running"
        : approval.status === "rejected"
          ? "draft"
          : "draft";

    await updateAgentTaskStatus(user.id, approval.taskId, nextStatus);
    await createAgentTaskEvent(user.id, approval.taskId, approval.runId, {
      type: "approval_resolved",
      content: `${approval.type} ${approval.status}`,
      metadata: { approvalId: approval.id, status: approval.status },
    });

    const detail = await getAgentTaskDetail(user.id, approval.taskId);
    return c.json(detail);
  } catch (error) {
    const status = error instanceof Error && error.message === "Approval not found" ? 404 : 400;
    return c.json({ error: error instanceof Error ? error.message : "Failed to respond to approval" }, status);
  }
});

agent.post("/tasks/:id/execute", async (c) => {
  const user = c.get("user");
  const taskId = c.req.param("id");
  return createTaskExecutionResponse(user.id, taskId, "execute");
});

agent.post("/tasks/:id/retry", async (c) => {
  const user = c.get("user");
  const taskId = c.req.param("id");
  return createTaskExecutionResponse(user.id, taskId, "retry");
});

agent.post("/tasks/:id/continue", async (c) => {
  const user = c.get("user");
  const taskId = c.req.param("id");
  return createTaskExecutionResponse(user.id, taskId, "continue");
});

agent.post("/tasks/:id/cancel", async (c) => {
  const user = c.get("user");
  const taskId = c.req.param("id");
  const task = await getAgentTaskById(user.id, taskId);
  if (!task) {
    return c.json({ error: "Task not found" }, 404);
  }
  await updateAgentTaskStatus(user.id, taskId, "cancelled");
  const detail = await getAgentTaskDetail(user.id, taskId);
  return c.json(detail);
});

agent.get("/sessions", async (c) => {
  const user = c.get("user");

  const sessions = await getAgentSessions(user.id);
  return c.json({ sessions });
});

agent.get("/sessions/:id/events", async (c) => {
  const user = c.get("user");

  const sessionId = c.req.param("id");
  const events = await getAgentEvents(user.id, sessionId);
  return c.json({ events });
});

agent.delete("/events/:eventId", async (c) => {
  const user = c.get("user");
  const eventId = c.req.param("eventId");
  const ok = await deleteAgentEvent(user.id, eventId);
  if (!ok) return c.json({ error: "Not found" }, 404);
  return c.json({ success: true });
});

agent.get("/sessions/:id", async (c) => {
  const user = c.get("user");

  const sessionId = c.req.param("id");
  const session = await getAgentSessionById(user.id, sessionId);

  if (!session) {
    return c.json({ error: "Session not found" }, 404);
  }

  return c.json({ session });
});

agent.post("/sessions", async (c) => {
  const user = c.get("user");

  try {
    const body = await c.req.json();
    const session = await createAgentSession(user.id, body);
    return c.json({ session }, 201);
  } catch (error) {
    return c.json(
      {
        error: error instanceof Error ? error.message : "Failed to create session",
      },
      400,
    );
  }
});

agent.post("/sessions/:id/run", async (c) => {
  const user = c.get("user");

  const sessionId = c.req.param("id");
  const session = await getAgentSessionById(user.id, sessionId);
  if (!session) {
    return c.text("Session not found", 404);
  }

  const body = (await c.req.json().catch(() => null)) as unknown;
  if (!isRecord(body)) {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const prompt = body.prompt;
  const attachmentsRaw = body.attachments;

  const hasPrompt = typeof prompt === "string" && prompt.trim().length > 0;
  const attachments = Array.isArray(attachmentsRaw)
    ? attachmentsRaw.filter(
        (value): value is string => typeof value === "string" && value.trim().length > 0,
      )
    : [];
  const hasAttachments = attachments.length > 0;
  if (!hasPrompt && !hasAttachments) {
    return c.json({ error: "prompt or attachments are required" }, 400);
  }

  // Agent runtime is Anthropic-only (Claude Agent SDK). Fail fast for other providers
  // so users don't get stuck with a long "Running..." and no output.
  const resolvedChannel = await getResolvedChannelForConversation(user.id, {
    channelId: session.channelId || null,
    modelId: session.modelId || null,
  });
  const provider = resolvedChannel?.channel?.provider;
  if (!provider) {
    return c.text("未配置可用的默认渠道/默认模型。请先在设置中完成配置。", 400);
  }
  if (provider !== "anthropic") {
    return c.text(
      `Agent 模式目前仅支持 Anthropic(Claude Agent SDK)。当前 Provider: ${provider}。请切换到 Anthropic 渠道后重试。`,
      400,
    );
  }

  const compatibility = await checkChannelAgentCompatibility(
    user.id,
    resolvedChannel.channel.id,
    resolvedChannel.modelId,
  );
  if (compatibility.success === false) {
    return c.text(compatibility.error, 400);
  }

  const stream = createSseStream(async (send, ctx) => {
    let sawAny = false;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    const clearIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = null;
    };

    // If the provider doesn't produce any output quickly, fail fast instead of hanging forever.
    const firstOutputTimer = setTimeout(() => {
      try {
        ctx.abortController.abort("first_output_timeout");
      } catch {
        // ignore
      }
    }, 20_000);

    const armIdle = () => {
      clearIdle();
      idleTimer = setTimeout(() => {
        try {
          ctx.abortController.abort("idle_timeout");
        } catch {
          // ignore
        }
      }, 120_000);
    };

    try {
      armIdle();
      for await (const event of runAgent(
        user.id,
        sessionId,
        typeof prompt === "string" ? prompt : "",
        attachments,
        ctx.abortController,
      )) {
        const isVisibleEvent = event.type !== "meta";
        if (isVisibleEvent && !sawAny) {
          sawAny = true;
          clearTimeout(firstOutputTimer);
        }
        // Don't treat meta/keepalive as activity for the idle timer.
        if (isVisibleEvent) {
          armIdle();
        }
        send(event);
      }
    } finally {
      clearTimeout(firstOutputTimer);
      clearIdle();
    }
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
});

agent.put("/sessions/:id/channel", async (c) => {
  const user = c.get("user");

  const sessionId = c.req.param("id");
  const body = await c.req.json();
  const { channelId, modelId } = body;
  if (!channelId || !modelId) {
    return c.json({ error: "channelId and modelId are required" }, 400);
  }

  await updateAgentSessionChannel(user.id, sessionId, channelId, modelId);
  return c.json({ success: true });
});

agent.put("/sessions/:id/status", async (c) => {
  const user = c.get("user");

  const sessionId = c.req.param("id");
  const body = await c.req.json();
  const { status } = body;

  await updateAgentSessionStatus(user.id, sessionId, status);
  return c.json({ success: true });
});

agent.put("/sessions/:id", async (c) => {
  const user = c.get("user");

  try {
    const sessionId = c.req.param("id");
    const body = await c.req.json();
    const title = body?.title;
    if (typeof title !== "string" || !title.trim()) {
      return c.json({ error: "title is required" }, 400);
    }

    await renameAgentSession(user.id, sessionId, title);
    return c.json({ success: true });
  } catch (error) {
    if (error instanceof Error && error.message === "Session not found") {
      return c.json({ error: "Session not found" }, 404);
    }
    return c.json(
      {
        error: error instanceof Error ? error.message : "Failed to update session",
      },
      400,
    );
  }
});

agent.delete("/sessions/:id", async (c) => {
  const user = c.get("user");

  try {
    const sessionId = c.req.param("id");
    await deleteAgentSession(user.id, sessionId);
    return c.json({ success: true });
  } catch (error) {
    if (error instanceof Error && error.message === "Session not found") {
      return c.json({ error: "Session not found" }, 404);
    }
    return c.json(
      { error: error instanceof Error ? error.message : "Failed to delete session" },
      400,
    );
  }
});

agent.post("/sessions/:id/auto-title", async (c) => {
  const user = c.get("user");

  try {
    const sessionId = c.req.param("id");
    const session = await getAgentSessionById(user.id, sessionId);
    if (!session) {
      return c.json({ error: "Session not found" }, 404);
    }
    const body = await c.req.json().catch(() => ({}));
    const prompt = typeof body.prompt === "string" ? body.prompt : "";
    if (!prompt.trim()) {
      return c.json({ error: "prompt is required" }, 400);
    }
    const title = await generateAutoTitle(user.id, prompt, session.channelId || null);
    if (!title) {
      return c.json({ success: false, error: "Failed to generate title" });
    }
    await renameAgentSession(user.id, sessionId, title);
    return c.json({ success: true, title });
  } catch (error) {
    return c.json({ success: false, error: error instanceof Error ? error.message : "Failed" });
  }
});

export default agent;
