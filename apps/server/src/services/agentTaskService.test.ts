import { expect, test } from "bun:test";
import {
  agentApprovalRequests,
  agentArtifacts,
  agentPlanSteps,
  agentRuns,
  agentTaskEvents,
  agentTasks,
  users,
} from "db";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { bootstrapDatabase } from "../db/bootstrap";
import {
  createAgentApprovalRequest,
  createAgentArtifact,
  createAgentRun,
  createAgentTask,
  createAgentTaskEvent,
  getAgentTaskDetail,
  listAgentTasks,
  respondToAgentApproval,
  setAgentPlanSteps,
  updateAgentPlanStepStatuses,
  updateAgentRunStatus,
  updateAgentTaskStatus,
} from "./agentTaskService";

async function insertTestUser(userId: string) {
  await db.insert(users).values({
    id: userId,
    email: `${userId}@test.local`,
    username: "task-user",
    passwordHash: "x",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

async function cleanupTestUser(userId: string) {
  await db.delete(agentTaskEvents).where(eq(agentTaskEvents.taskId, "__missing__"));
  await db.delete(agentArtifacts).where(eq(agentArtifacts.taskId, "__missing__"));
  await db.delete(agentApprovalRequests).where(eq(agentApprovalRequests.taskId, "__missing__"));
  await db.delete(agentPlanSteps).where(eq(agentPlanSteps.taskId, "__missing__"));
  await db.delete(agentRuns).where(eq(agentRuns.taskId, "__missing__"));

  const tasks = await db.select({ id: agentTasks.id }).from(agentTasks).where(eq(agentTasks.userId, userId));
  for (const task of tasks) {
    await db.delete(agentTaskEvents).where(eq(agentTaskEvents.taskId, task.id));
    await db.delete(agentArtifacts).where(eq(agentArtifacts.taskId, task.id));
    await db.delete(agentApprovalRequests).where(eq(agentApprovalRequests.taskId, task.id));
    await db.delete(agentPlanSteps).where(eq(agentPlanSteps.taskId, task.id));
    await db.delete(agentRuns).where(eq(agentRuns.taskId, task.id));
    await db.delete(agentTasks).where(eq(agentTasks.id, task.id));
  }

  await db.delete(users).where(eq(users.id, userId));
}

test("agentTaskService persists tasks, plans, approvals, and task detail", async () => {
  await bootstrapDatabase();
  const userId = crypto.randomUUID();
  await insertTestUser(userId);

  try {
    const task = await createAgentTask(userId, {
      goal: "Audit the current web agent workbench and prepare an execution plan.",
    });

    expect(task.status).toBe("draft");
    expect(task.title).toContain("Audit the current web agent workbench");

    const planningRun = await createAgentRun(userId, task.id, {
      phase: "planning",
      status: "running",
      startedAt: new Date(),
    });
    await updateAgentTaskStatus(userId, task.id, "planning");

    const planSteps = await setAgentPlanSteps(userId, task.id, planningRun.id, {
      steps: [
        { title: "Inspect current implementation", description: "Review routes, services, and data model." },
        { title: "Draft execution plan", description: "Break the task into reviewable milestones.", status: "ready" },
      ],
    });

    expect(planSteps).toHaveLength(2);
    expect(planSteps[1]?.status).toBe("ready");

    const updatedSteps = await updateAgentPlanStepStatuses(userId, {
      steps: [
        { id: planSteps[0]!.id, status: "completed" },
        { id: planSteps[1]!.id, status: "running" },
      ],
    });

    expect(updatedSteps[0]?.status).toBe("completed");
    expect(updatedSteps[1]?.status).toBe("running");

    const approval = await createAgentApprovalRequest(userId, task.id, planningRun.id, {
      type: "plan_approval",
      title: "Approve execution",
      description: "Review the generated plan before execution starts.",
      payload: { stepCount: planSteps.length },
    });

    expect(approval.status).toBe("pending");

    await updateAgentRunStatus(userId, planningRun.id, "awaiting_approval");
    await updateAgentTaskStatus(userId, task.id, "awaiting_approval");

    const approved = await respondToAgentApproval(userId, approval.id, {
      status: "approved",
      response: { approvedBy: "test" },
    });

    expect(approved.status).toBe("approved");

    const detail = await getAgentTaskDetail(userId, task.id);

    expect(detail.task.status).toBe("awaiting_approval");
    expect(detail.task.insight?.highlight).toBe("plan_approval");
    expect(detail.task.insight?.latestApprovalType).toBe("plan_approval");
    expect(detail.task.insight?.latestApprovalStatus).toBe("approved");
    expect(detail.runs).toHaveLength(1);
    expect(detail.planSteps).toHaveLength(2);
    expect(detail.planSteps[0]?.status).toBe("completed");
    expect(detail.planSteps[1]?.status).toBe("running");
    expect(detail.approvals).toHaveLength(1);
    expect(detail.approvals[0]?.response).toEqual({ approvedBy: "test" });

    const list = await listAgentTasks(userId);
    expect(list.map((item) => item.id)).toEqual([task.id]);
    expect(list[0]?.insight?.highlight).toBe("plan_approval");
    expect(list[0]?.insight?.summary).toBeNull();
  } finally {
    await cleanupTestUser(userId);
  }
});

test("agentTaskService persists execution artifacts separately from raw events", async () => {
  await bootstrapDatabase();
  const userId = crypto.randomUUID();
  await insertTestUser(userId);

  try {
    const task = await createAgentTask(userId, {
      title: "Run task",
      goal: "Execute the approved plan and store the result separately from logs.",
    });

    const run = await createAgentRun(userId, task.id, {
      phase: "execution",
      status: "running",
      startedAt: new Date(),
    });

    await updateAgentTaskStatus(userId, task.id, "running");
    await createAgentTaskEvent(userId, task.id, run.id, {
      type: "execution_event",
      content: "Running the approved plan.",
      metadata: { section: "execution" },
    });

    await createAgentArtifact(userId, task.id, run.id, {
      type: "final_result",
      title: "Final result",
      content: "Task completed successfully.",
    });
    await createAgentArtifact(userId, task.id, run.id, {
      type: "execution_summary",
      title: "Execution summary",
      content: "1 event, 0 tool calls",
      metadata: { eventCount: 1, toolCalls: 0 },
    });

    await updateAgentRunStatus(userId, run.id, "completed", {
      summary: "Task completed successfully.",
      completedAt: new Date(),
    });
    await updateAgentTaskStatus(userId, task.id, "completed");

    const detail = await getAgentTaskDetail(userId, task.id);

    expect(detail.task.status).toBe("completed");
    expect(detail.task.insight?.highlight).toBe("final_result");
    expect(detail.task.insight?.summary).toBe("Task completed successfully.");
    expect(detail.task.insight?.hasFinalResult).toBe(true);
    expect(detail.events).toHaveLength(1);
    expect(detail.artifacts).toHaveLength(2);
    expect(detail.artifacts.map((item) => item.type)).toEqual([
      "final_result",
      "execution_summary",
    ]);
    expect(detail.events[0]?.content).toBe("Running the approved plan.");

    const list = await listAgentTasks(userId);
    expect(list[0]?.insight?.highlight).toBe("final_result");
    expect(list[0]?.insight?.summary).toBe("Task completed successfully.");
  } finally {
    await cleanupTestUser(userId);
  }
});
