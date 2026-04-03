import {
  agentApprovalRequests,
  agentArtifacts,
  agentPlanSteps,
  agentRuns,
  agentTaskEvents,
  agentTasks,
} from "db";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { db } from "../db";
import { generateId } from "../utils";

export type AgentTaskStatus =
  | "draft"
  | "planning"
  | "awaiting_approval"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";
export type AgentTaskComplexity = "light" | "standard" | "deep";
export type AgentTaskUxMode = "direct" | "compact" | "full";

export type AgentRunPhase = "planning" | "execution";
export type AgentRunStatus =
  | "pending"
  | "running"
  | "awaiting_approval"
  | "completed"
  | "failed"
  | "cancelled";
export type AgentPlanStepStatus = "pending" | "ready" | "running" | "completed" | "failed";
export type AgentApprovalType = "plan_approval" | "tool_approval";
export type AgentApprovalStatus = "pending" | "approved" | "rejected";
export type AgentArtifactType =
  | "final_result"
  | "execution_summary"
  | "structured_result"
  | "source_bundle";
export type AgentTaskEventType =
  | "task_status"
  | "plan_step"
  | "execution_event"
  | "approval_requested"
  | "approval_resolved"
  | "artifact_created"
  | "final_result"
  | "error"
  | "done";

export interface AgentTaskAttachment {
  id?: string;
  fileName: string;
  fileType?: string;
  fileSize?: number;
}

export interface AgentTaskRecord {
  id: string;
  userId: string;
  conversationId: string | null;
  channelId: string | null;
  modelId: string | null;
  title: string;
  goal: string;
  attachments: AgentTaskAttachment[];
  complexity: AgentTaskComplexity;
  uxMode: AgentTaskUxMode;
  requiresPlanApproval: boolean;
  autoStart: boolean;
  status: AgentTaskStatus;
  insight: AgentTaskInsightRecord | null;
  createdAt: string;
  updatedAt: string;
}

export interface AgentRunRecord {
  id: string;
  taskId: string;
  phase: AgentRunPhase;
  status: AgentRunStatus;
  summary: string | null;
  error: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AgentPlanStepRecord {
  id: string;
  taskId: string;
  runId: string;
  orderIndex: number;
  title: string;
  description: string | null;
  status: AgentPlanStepStatus;
  createdAt: string;
  updatedAt: string;
}

export interface AgentApprovalRecord {
  id: string;
  taskId: string;
  runId: string;
  type: AgentApprovalType;
  status: AgentApprovalStatus;
  title: string;
  description: string | null;
  payload: unknown;
  response: unknown;
  requestedAt: string;
  respondedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AgentArtifactRecord {
  id: string;
  taskId: string;
  runId: string;
  type: AgentArtifactType;
  title: string;
  content: string;
  metadata: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface AgentTaskEventRecord {
  id: string;
  taskId: string;
  runId: string;
  type: AgentTaskEventType;
  content: string | null;
  toolName: string | null;
  toolInput: unknown;
  metadata: unknown;
  createdAt: string;
}

export interface AgentTaskRuntimeRecord {
  channelId: string | null;
  channelName: string | null;
  modelId: string | null;
  source: "event" | "task";
}

export type AgentTaskInsightHighlight =
  | "tool_approval"
  | "plan_approval"
  | "execution_failed"
  | "final_result";
export type AgentTaskInsightPreviewKind = "error" | "result" | "summary";

export interface AgentTaskInsightRecord {
  highlight: AgentTaskInsightHighlight | null;
  summary: string | null;
  previewKind: AgentTaskInsightPreviewKind | null;
  previewText: string | null;
  runCount: number;
  latestRunStatus: AgentRunStatus | null;
  latestRunPhase: AgentRunPhase | null;
  latestApprovalType: AgentApprovalType | null;
  latestApprovalStatus: AgentApprovalStatus | null;
  hasFinalResult: boolean;
}

export interface AgentTaskDetail {
  task: AgentTaskRecord;
  runs: AgentRunRecord[];
  planSteps: AgentPlanStepRecord[];
  approvals: AgentApprovalRecord[];
  artifacts: AgentArtifactRecord[];
  events: AgentTaskEventRecord[];
  runtime?: AgentTaskRuntimeRecord | null;
}

export interface CreateAgentTaskInput {
  conversationId?: string | null;
  channelId?: string | null;
  modelId?: string | null;
  title?: string | null;
  goal: string;
  attachments?: AgentTaskAttachment[];
  complexity?: AgentTaskComplexity;
  uxMode?: AgentTaskUxMode;
  requiresPlanApproval?: boolean;
  autoStart?: boolean;
}

export interface UpdateAgentTaskInput {
  title?: string | null;
  goal?: string;
}

export interface CreateAgentRunInput {
  phase: AgentRunPhase;
  status?: AgentRunStatus;
  summary?: string | null;
  error?: string | null;
  startedAt?: Date | null;
  completedAt?: Date | null;
}

export interface SetAgentPlanStepsInput {
  steps: Array<{
    title: string;
    description?: string | null;
    status?: AgentPlanStepStatus;
  }>;
}

export interface UpdateAgentPlanStepStatusesInput {
  steps: Array<{
    id: string;
    status: AgentPlanStepStatus;
  }>;
}

export interface CreateAgentApprovalInput {
  type: AgentApprovalType;
  title: string;
  description?: string | null;
  payload?: unknown;
  status?: AgentApprovalStatus;
}

export interface RespondToAgentApprovalInput {
  status: Exclude<AgentApprovalStatus, "pending">;
  response?: unknown;
}

export interface CreateAgentArtifactInput {
  type: AgentArtifactType;
  title: string;
  content: string;
  metadata?: unknown;
}

export interface CreateAgentTaskEventInput {
  type: AgentTaskEventType;
  content?: string | null;
  toolName?: string | null;
  toolInput?: unknown;
  metadata?: unknown;
  createdAt?: Date;
}

function stringifyJson(value: unknown): string | null {
  if (value === undefined) return null;
  return JSON.stringify(value);
}

function parseJson<T>(value: string | null): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function toIsoString(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function buildTaskTitle(goal: string, title?: string | null): string {
  const candidate = title?.trim();
  if (candidate) return candidate;
  const normalized = goal.trim().replace(/\s+/g, " ");
  if (!normalized) return "Untitled task";
  return normalized.length > 80 ? `${normalized.slice(0, 77)}...` : normalized;
}

function mapTask(row: typeof agentTasks.$inferSelect): AgentTaskRecord {
  return {
    id: row.id,
    userId: row.userId,
    conversationId: row.conversationId ?? null,
    channelId: row.channelId ?? null,
    modelId: row.modelId ?? null,
    title: row.title,
    goal: row.goal,
    attachments: parseJson<AgentTaskAttachment[]>(row.attachments) ?? [],
    complexity: (row.complexity as AgentTaskComplexity) ?? "deep",
    uxMode: (row.uxMode as AgentTaskUxMode) ?? "full",
    requiresPlanApproval: Boolean(row.requiresPlanApproval),
    autoStart: Boolean(row.autoStart),
    status: row.status as AgentTaskStatus,
    insight: null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function mapRun(row: typeof agentRuns.$inferSelect): AgentRunRecord {
  return {
    id: row.id,
    taskId: row.taskId,
    phase: row.phase as AgentRunPhase,
    status: row.status as AgentRunStatus,
    summary: row.summary ?? null,
    error: row.error ?? null,
    startedAt: toIsoString(row.startedAt ?? null),
    completedAt: toIsoString(row.completedAt ?? null),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function mapPlanStep(row: typeof agentPlanSteps.$inferSelect): AgentPlanStepRecord {
  return {
    id: row.id,
    taskId: row.taskId,
    runId: row.runId,
    orderIndex: row.orderIndex,
    title: row.title,
    description: row.description ?? null,
    status: row.status as AgentPlanStepStatus,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function mapApproval(row: typeof agentApprovalRequests.$inferSelect): AgentApprovalRecord {
  return {
    id: row.id,
    taskId: row.taskId,
    runId: row.runId,
    type: row.type as AgentApprovalType,
    status: row.status as AgentApprovalStatus,
    title: row.title,
    description: row.description ?? null,
    payload: parseJson(row.payload),
    response: parseJson(row.response),
    requestedAt: row.requestedAt.toISOString(),
    respondedAt: toIsoString(row.respondedAt ?? null),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function mapArtifact(row: typeof agentArtifacts.$inferSelect): AgentArtifactRecord {
  return {
    id: row.id,
    taskId: row.taskId,
    runId: row.runId,
    type: row.type as AgentArtifactType,
    title: row.title,
    content: row.content,
    metadata: parseJson(row.metadata),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function mapTaskEvent(row: typeof agentTaskEvents.$inferSelect): AgentTaskEventRecord {
  return {
    id: row.id,
    taskId: row.taskId,
    runId: row.runId,
    type: row.type as AgentTaskEventType,
    content: row.content ?? null,
    toolName: row.toolName ?? null,
    toolInput: parseJson(row.toolInput),
    metadata: parseJson(row.metadata),
    createdAt: row.createdAt.toISOString(),
  };
}

function clipInsightText(value: string | null | undefined, max = 160) {
  const normalized = value?.trim();
  if (!normalized) return null;
  return normalized.length > max ? `${normalized.slice(0, Math.max(0, max - 1))}…` : normalized;
}

function buildTaskInsight(params: {
  taskStatus: AgentTaskStatus;
  runs: AgentRunRecord[];
  approvals: AgentApprovalRecord[];
  artifacts: AgentArtifactRecord[];
}): AgentTaskInsightRecord | null {
  const latestRun = params.runs[0] ?? null;
  const latestExecutionRun = params.runs.find((run) => run.phase === "execution") ?? null;
  const latestApproval = params.approvals[0] ?? null;
  const latestFinalResult =
    (latestExecutionRun
      ? params.artifacts.find(
          (artifact) =>
            artifact.runId === latestExecutionRun.id && artifact.type === "final_result",
        )
      : null) ??
    params.artifacts.find((artifact) => artifact.type === "final_result") ??
    null;

  const highlight: AgentTaskInsightHighlight | null =
    params.taskStatus === "awaiting_approval" &&
    latestApproval?.status === "pending" &&
    latestApproval.type === "tool_approval"
      ? "tool_approval"
      : params.taskStatus === "awaiting_approval"
        ? "plan_approval"
        : params.taskStatus === "failed"
          ? "execution_failed"
          : latestFinalResult
            ? "final_result"
            : null;

  const previewSource =
    params.taskStatus === "failed" && latestExecutionRun?.error?.trim()
      ? {
          kind: "error" as const,
          text: latestExecutionRun.error,
        }
      : latestFinalResult?.content?.trim()
        ? {
            kind: "result" as const,
            text: latestFinalResult.content,
          }
        : latestExecutionRun?.summary?.trim()
          ? {
              kind: "summary" as const,
              text: latestExecutionRun.summary,
            }
          : latestRun?.summary?.trim()
            ? {
                kind: "summary" as const,
                text: latestRun.summary,
              }
            : null;

  const previewKind = previewSource?.kind ?? null;
  const previewText = clipInsightText(previewSource?.text ?? null);
  const summary = previewText;

  if (
    !highlight &&
    !previewText &&
    !latestRun &&
    !latestApproval &&
    !latestFinalResult
  ) {
    return null;
  }

  return {
    highlight,
    summary,
    previewKind,
    previewText,
    runCount: params.runs.length,
    latestRunStatus: latestRun?.status ?? null,
    latestRunPhase: latestRun?.phase ?? null,
    latestApprovalType: latestApproval?.type ?? null,
    latestApprovalStatus: latestApproval?.status ?? null,
    hasFinalResult: Boolean(latestFinalResult),
  };
}

function attachTaskInsight(
  task: AgentTaskRecord,
  runs: AgentRunRecord[],
  approvals: AgentApprovalRecord[],
  artifacts: AgentArtifactRecord[],
): AgentTaskRecord {
  return {
    ...task,
    insight: buildTaskInsight({
      taskStatus: task.status,
      runs,
      approvals,
      artifacts,
    }),
  };
}

function getEventRuntime(event: AgentTaskEventRecord): AgentTaskRuntimeRecord | null {
  if (event.type !== "execution_event") return null;
  if (!event.metadata || typeof event.metadata !== "object" || Array.isArray(event.metadata)) {
    return null;
  }

  const metadata = event.metadata as Record<string, unknown>;
  if (metadata.source !== "runtime_selection") return null;

  const modelId = typeof metadata.modelId === "string" ? metadata.modelId : null;
  const channelId = typeof metadata.channelId === "string" ? metadata.channelId : null;
  const channelName = typeof metadata.channelName === "string" ? metadata.channelName : null;

  if (!modelId && !channelId && !channelName) {
    return null;
  }

  return {
    channelId,
    channelName,
    modelId,
    source: "event",
  };
}

function deriveTaskRuntime(task: AgentTaskRecord, events: AgentTaskEventRecord[]): AgentTaskRuntimeRecord | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const runtime = getEventRuntime(events[index]!);
    if (runtime) return runtime;
  }

  if (!task.modelId && !task.channelId) {
    return null;
  }

  return {
    channelId: task.channelId ?? null,
    channelName: null,
    modelId: task.modelId ?? null,
    source: "task",
  };
}

async function getTaskRow(userId: string, taskId: string) {
  const rows = await db
    .select()
    .from(agentTasks)
    .where(and(eq(agentTasks.id, taskId), eq(agentTasks.userId, userId)))
    .limit(1);
  return rows[0] ?? null;
}

async function assertTaskRow(userId: string, taskId: string) {
  const task = await getTaskRow(userId, taskId);
  if (!task) {
    throw new Error("Task not found");
  }
  return task;
}

async function getRunRow(userId: string, runId: string) {
  const rows = await db
    .select({ run: agentRuns })
    .from(agentRuns)
    .innerJoin(agentTasks, eq(agentRuns.taskId, agentTasks.id))
    .where(and(eq(agentRuns.id, runId), eq(agentTasks.userId, userId)))
    .limit(1);
  return rows[0]?.run ?? null;
}

async function assertRunRow(userId: string, runId: string) {
  const run = await getRunRow(userId, runId);
  if (!run) {
    throw new Error("Run not found");
  }
  return run;
}

async function getPlanStepRows(userId: string, stepIds: string[]) {
  if (stepIds.length === 0) return [];
  const rows = await db
    .select({ step: agentPlanSteps })
    .from(agentPlanSteps)
    .innerJoin(agentTasks, eq(agentPlanSteps.taskId, agentTasks.id))
    .where(and(eq(agentTasks.userId, userId), inArray(agentPlanSteps.id, stepIds)));
  return rows.map((row) => row.step);
}

async function getApprovalRow(userId: string, approvalId: string) {
  const rows = await db
    .select({ approval: agentApprovalRequests })
    .from(agentApprovalRequests)
    .innerJoin(agentTasks, eq(agentApprovalRequests.taskId, agentTasks.id))
    .where(and(eq(agentApprovalRequests.id, approvalId), eq(agentTasks.userId, userId)))
    .limit(1);
  return rows[0]?.approval ?? null;
}

export async function createAgentTask(userId: string, input: CreateAgentTaskInput) {
  const now = new Date();
  const id = generateId();
  const goal = input.goal.trim();
  if (!goal) {
    throw new Error("goal is required");
  }

  await db.insert(agentTasks).values({
    id,
    userId,
    conversationId: input.conversationId ?? null,
    channelId: input.channelId ?? null,
    modelId: input.modelId ?? null,
    title: buildTaskTitle(goal, input.title),
    goal,
    attachments: stringifyJson(input.attachments ?? []),
    complexity: input.complexity ?? "deep",
    uxMode: input.uxMode ?? "full",
    requiresPlanApproval: input.requiresPlanApproval ?? true,
    autoStart: input.autoStart ?? false,
    status: "draft",
    createdAt: now,
    updatedAt: now,
  });

  return mapTask((await assertTaskRow(userId, id)) as typeof agentTasks.$inferSelect);
}

export async function listAgentTasks(userId: string) {
  const rows = await db
    .select()
    .from(agentTasks)
    .where(eq(agentTasks.userId, userId))
    .orderBy(desc(agentTasks.updatedAt));
  if (rows.length === 0) {
    return [] as AgentTaskRecord[];
  }

  const taskIds = rows.map((row) => row.id);
  const [runRows, approvalRows, artifactRows] = await Promise.all([
    db.select().from(agentRuns).where(inArray(agentRuns.taskId, taskIds)).orderBy(desc(agentRuns.createdAt)),
    db
      .select()
      .from(agentApprovalRequests)
      .where(inArray(agentApprovalRequests.taskId, taskIds))
      .orderBy(desc(agentApprovalRequests.requestedAt)),
    db
      .select()
      .from(agentArtifacts)
      .where(inArray(agentArtifacts.taskId, taskIds))
      .orderBy(desc(agentArtifacts.createdAt)),
  ]);

  const runsByTaskId = new Map<string, AgentRunRecord[]>();
  for (const row of runRows) {
    const list = runsByTaskId.get(row.taskId) ?? [];
    list.push(mapRun(row));
    runsByTaskId.set(row.taskId, list);
  }

  const approvalsByTaskId = new Map<string, AgentApprovalRecord[]>();
  for (const row of approvalRows) {
    const list = approvalsByTaskId.get(row.taskId) ?? [];
    list.push(mapApproval(row));
    approvalsByTaskId.set(row.taskId, list);
  }

  const artifactsByTaskId = new Map<string, AgentArtifactRecord[]>();
  for (const row of artifactRows) {
    const list = artifactsByTaskId.get(row.taskId) ?? [];
    list.push(mapArtifact(row));
    artifactsByTaskId.set(row.taskId, list);
  }

  return rows.map((row) =>
    attachTaskInsight(
      mapTask(row),
      runsByTaskId.get(row.id) ?? [],
      approvalsByTaskId.get(row.id) ?? [],
      artifactsByTaskId.get(row.id) ?? [],
    ),
  );
}

export async function getAgentTaskById(userId: string, taskId: string) {
  const task = await getTaskRow(userId, taskId);
  return task ? mapTask(task) : null;
}

export async function updateAgentTask(
  userId: string,
  taskId: string,
  input: UpdateAgentTaskInput,
) {
  const existing = await assertTaskRow(userId, taskId);

  if (existing.status === "running" || existing.status === "planning") {
    throw new Error("Cannot edit a task while it is planning or running");
  }

  const nextGoal = input.goal === undefined ? existing.goal : input.goal.trim();
  if (!nextGoal) {
    throw new Error("goal is required");
  }

  const existingAutoTitle = buildTaskTitle(existing.goal);
  const nextTitle =
    input.title !== undefined
      ? buildTaskTitle(nextGoal, input.title)
      : existing.title === existingAutoTitle
        ? buildTaskTitle(nextGoal)
        : existing.title;
  const goalChanged = nextGoal !== existing.goal;
  const now = new Date();

  await db
    .update(agentTasks)
    .set({
      title: nextTitle,
      goal: nextGoal,
      status: goalChanged ? "draft" : (existing.status as AgentTaskStatus),
      updatedAt: now,
    })
    .where(and(eq(agentTasks.id, taskId), eq(agentTasks.userId, userId)));

  if (goalChanged) {
    await db
      .update(agentApprovalRequests)
      .set({
        status: "rejected",
        response: stringifyJson({ source: "task_goal_updated" }),
        respondedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(agentApprovalRequests.taskId, taskId),
          eq(agentApprovalRequests.type, "plan_approval"),
          inArray(agentApprovalRequests.status, ["pending", "approved"]),
        ),
      );
  }

  return mapTask((await assertTaskRow(userId, taskId)) as typeof agentTasks.$inferSelect);
}

export async function updateAgentTaskStatus(
  userId: string,
  taskId: string,
  status: AgentTaskStatus,
) {
  await assertTaskRow(userId, taskId);
  await db
    .update(agentTasks)
    .set({
      status,
      updatedAt: new Date(),
    })
    .where(and(eq(agentTasks.id, taskId), eq(agentTasks.userId, userId)));
  return mapTask((await assertTaskRow(userId, taskId)) as typeof agentTasks.$inferSelect);
}

export async function createAgentRun(userId: string, taskId: string, input: CreateAgentRunInput) {
  await assertTaskRow(userId, taskId);
  const now = new Date();
  const id = generateId();
  await db.insert(agentRuns).values({
    id,
    taskId,
    phase: input.phase,
    status: input.status ?? "pending",
    summary: input.summary ?? null,
    error: input.error ?? null,
    startedAt: input.startedAt ?? null,
    completedAt: input.completedAt ?? null,
    createdAt: now,
    updatedAt: now,
  });
  await db
    .update(agentTasks)
    .set({ updatedAt: now })
    .where(and(eq(agentTasks.id, taskId), eq(agentTasks.userId, userId)));
  return mapRun((await assertRunRow(userId, id)) as typeof agentRuns.$inferSelect);
}

export async function updateAgentRunStatus(
  userId: string,
  runId: string,
  status: AgentRunStatus,
  updates?: {
    summary?: string | null;
    error?: string | null;
    startedAt?: Date | null;
    completedAt?: Date | null;
  },
) {
  const run = await assertRunRow(userId, runId);
  const now = new Date();
  await db
    .update(agentRuns)
    .set({
      status,
      summary: updates?.summary ?? run.summary ?? null,
      error: updates?.error ?? run.error ?? null,
      startedAt: updates?.startedAt === undefined ? run.startedAt ?? null : updates.startedAt,
      completedAt:
        updates?.completedAt === undefined ? run.completedAt ?? null : updates.completedAt,
      updatedAt: now,
    })
    .where(eq(agentRuns.id, runId));
  await db.update(agentTasks).set({ updatedAt: now }).where(eq(agentTasks.id, run.taskId));
  return mapRun((await assertRunRow(userId, runId)) as typeof agentRuns.$inferSelect);
}

export async function setAgentPlanSteps(
  userId: string,
  taskId: string,
  runId: string,
  input: SetAgentPlanStepsInput,
) {
  await assertTaskRow(userId, taskId);
  await assertRunRow(userId, runId);
  await db.delete(agentPlanSteps).where(eq(agentPlanSteps.runId, runId));

  const now = new Date();
  const steps = input.steps
    .map((step, index) => ({
      id: generateId(),
      taskId,
      runId,
      orderIndex: index,
      title: step.title.trim(),
      description: step.description?.trim() || null,
      status: step.status ?? "pending",
      createdAt: now,
      updatedAt: now,
    }))
    .filter((step) => step.title.length > 0);

  if (steps.length > 0) {
    await db.insert(agentPlanSteps).values(steps);
  }

  const rows = await db
    .select()
    .from(agentPlanSteps)
    .where(eq(agentPlanSteps.runId, runId))
    .orderBy(asc(agentPlanSteps.orderIndex), asc(agentPlanSteps.createdAt));
  return rows.map(mapPlanStep);
}

export async function listAgentPlanSteps(userId: string, taskId: string) {
  await assertTaskRow(userId, taskId);
  const rows = await db
    .select()
    .from(agentPlanSteps)
    .where(eq(agentPlanSteps.taskId, taskId))
    .orderBy(desc(agentPlanSteps.createdAt), asc(agentPlanSteps.orderIndex));
  return rows.map(mapPlanStep);
}

export async function updateAgentPlanStepStatuses(
  userId: string,
  input: UpdateAgentPlanStepStatusesInput,
) {
  if (input.steps.length === 0) {
    return [] as AgentPlanStepRecord[];
  }

  const rows = await getPlanStepRows(
    userId,
    input.steps.map((step) => step.id),
  );
  if (rows.length !== input.steps.length) {
    throw new Error("Plan step not found");
  }

  const updatesById = new Map(input.steps.map((step) => [step.id, step.status] as const));
  const now = new Date();

  for (const row of rows) {
    const nextStatus = updatesById.get(row.id);
    if (!nextStatus || row.status === nextStatus) {
      continue;
    }
    await db
      .update(agentPlanSteps)
      .set({
        status: nextStatus,
        updatedAt: now,
      })
      .where(eq(agentPlanSteps.id, row.id));
  }

  const affectedTaskIds = [...new Set(rows.map((row) => row.taskId))];
  for (const taskId of affectedTaskIds) {
    await db.update(agentTasks).set({ updatedAt: now }).where(eq(agentTasks.id, taskId));
  }

  const updatedRows = await getPlanStepRows(
    userId,
    input.steps.map((step) => step.id),
  );
  const byId = new Map(updatedRows.map((row) => [row.id, mapPlanStep(row)] as const));
  return input.steps
    .map((step) => byId.get(step.id))
    .filter((step): step is AgentPlanStepRecord => Boolean(step));
}

export async function createAgentApprovalRequest(
  userId: string,
  taskId: string,
  runId: string,
  input: CreateAgentApprovalInput,
) {
  await assertTaskRow(userId, taskId);
  await assertRunRow(userId, runId);
  const now = new Date();
  const id = generateId();
  await db.insert(agentApprovalRequests).values({
    id,
    taskId,
    runId,
    type: input.type,
    status: input.status ?? "pending",
    title: input.title.trim(),
    description: input.description?.trim() || null,
    payload: stringifyJson(input.payload),
    response: null,
    requestedAt: now,
    respondedAt: null,
    createdAt: now,
    updatedAt: now,
  });
  const row = await getApprovalRow(userId, id);
  if (!row) throw new Error("Approval not found");
  return mapApproval(row);
}

export async function respondToAgentApproval(
  userId: string,
  approvalId: string,
  input: RespondToAgentApprovalInput,
) {
  const existing = await getApprovalRow(userId, approvalId);
  if (!existing) {
    throw new Error("Approval not found");
  }
  const now = new Date();
  await db
    .update(agentApprovalRequests)
    .set({
      status: input.status,
      response: stringifyJson(input.response),
      respondedAt: now,
      updatedAt: now,
    })
    .where(eq(agentApprovalRequests.id, approvalId));
  const row = await getApprovalRow(userId, approvalId);
  if (!row) throw new Error("Approval not found");
  return mapApproval(row);
}

export async function listAgentApprovals(userId: string, taskId: string) {
  await assertTaskRow(userId, taskId);
  const rows = await db
    .select()
    .from(agentApprovalRequests)
    .where(eq(agentApprovalRequests.taskId, taskId))
    .orderBy(desc(agentApprovalRequests.requestedAt));
  return rows.map(mapApproval);
}

export async function getLatestApprovalForTask(
  userId: string,
  taskId: string,
  type?: AgentApprovalType,
) {
  await assertTaskRow(userId, taskId);
  const rows = await db
    .select()
    .from(agentApprovalRequests)
    .where(
      and(
        eq(agentApprovalRequests.taskId, taskId),
        ...(type ? [eq(agentApprovalRequests.type, type)] : []),
      ),
    )
    .orderBy(desc(agentApprovalRequests.requestedAt))
    .limit(1);
  return rows[0] ? mapApproval(rows[0]) : null;
}

export async function createAgentArtifact(
  userId: string,
  taskId: string,
  runId: string,
  input: CreateAgentArtifactInput,
) {
  await assertTaskRow(userId, taskId);
  await assertRunRow(userId, runId);
  const now = new Date();
  const id = generateId();
  await db.insert(agentArtifacts).values({
    id,
    taskId,
    runId,
    type: input.type,
    title: input.title.trim(),
    content: input.content,
    metadata: stringifyJson(input.metadata),
    createdAt: now,
    updatedAt: now,
  });
  const rows = await db
    .select()
    .from(agentArtifacts)
    .where(eq(agentArtifacts.id, id))
    .limit(1);
  return mapArtifact(rows[0] as typeof agentArtifacts.$inferSelect);
}

export async function listAgentArtifacts(userId: string, taskId: string) {
  await assertTaskRow(userId, taskId);
  const rows = await db
    .select()
    .from(agentArtifacts)
    .where(eq(agentArtifacts.taskId, taskId))
    .orderBy(desc(agentArtifacts.createdAt));
  return rows.map(mapArtifact);
}

export async function createAgentTaskEvent(
  userId: string,
  taskId: string,
  runId: string,
  input: CreateAgentTaskEventInput,
) {
  await assertTaskRow(userId, taskId);
  await assertRunRow(userId, runId);
  const id = generateId();
  const createdAt = input.createdAt ?? new Date();
  await db.insert(agentTaskEvents).values({
    id,
    taskId,
    runId,
    type: input.type,
    content: input.content ?? null,
    toolName: input.toolName ?? null,
    toolInput: stringifyJson(input.toolInput),
    metadata: stringifyJson(input.metadata),
    createdAt,
  });
  const rows = await db
    .select()
    .from(agentTaskEvents)
    .where(eq(agentTaskEvents.id, id))
    .limit(1);
  return mapTaskEvent(rows[0] as typeof agentTaskEvents.$inferSelect);
}

export async function listAgentTaskEvents(userId: string, taskId: string) {
  await assertTaskRow(userId, taskId);
  const rows = await db
    .select()
    .from(agentTaskEvents)
    .where(eq(agentTaskEvents.taskId, taskId))
    .orderBy(asc(agentTaskEvents.createdAt));
  return rows.map(mapTaskEvent);
}

export async function getLatestRunForTask(userId: string, taskId: string, phase?: AgentRunPhase) {
  await assertTaskRow(userId, taskId);
  const rows = await db
    .select()
    .from(agentRuns)
    .where(and(eq(agentRuns.taskId, taskId), ...(phase ? [eq(agentRuns.phase, phase)] : [])))
    .orderBy(desc(agentRuns.createdAt))
    .limit(1);
  return rows[0] ? mapRun(rows[0]) : null;
}

export async function getAgentTaskDetail(userId: string, taskId: string): Promise<AgentTaskDetail> {
  const task = await assertTaskRow(userId, taskId);
  const [runs, planSteps, approvals, artifacts, events] = await Promise.all([
    db.select().from(agentRuns).where(eq(agentRuns.taskId, taskId)).orderBy(desc(agentRuns.createdAt)),
    db
      .select()
      .from(agentPlanSteps)
      .where(eq(agentPlanSteps.taskId, taskId))
      .orderBy(desc(agentPlanSteps.createdAt), asc(agentPlanSteps.orderIndex)),
    db
      .select()
      .from(agentApprovalRequests)
      .where(eq(agentApprovalRequests.taskId, taskId))
      .orderBy(desc(agentApprovalRequests.requestedAt)),
    db
      .select()
      .from(agentArtifacts)
      .where(eq(agentArtifacts.taskId, taskId))
      .orderBy(desc(agentArtifacts.createdAt)),
    db
      .select()
      .from(agentTaskEvents)
      .where(eq(agentTaskEvents.taskId, taskId))
      .orderBy(asc(agentTaskEvents.createdAt)),
  ]);

  const mappedRuns = runs.map(mapRun);
  const mappedApprovals = approvals.map(mapApproval);
  const mappedArtifacts = artifacts.map(mapArtifact);
  const mappedTask = attachTaskInsight(mapTask(task), mappedRuns, mappedApprovals, mappedArtifacts);
  const mappedEvents = events.map(mapTaskEvent);

  return {
    task: mappedTask,
    runs: mappedRuns,
    planSteps: planSteps.map(mapPlanStep),
    approvals: mappedApprovals,
    artifacts: mappedArtifacts,
    events: mappedEvents,
    runtime: deriveTaskRuntime(mappedTask, mappedEvents),
  };
}
