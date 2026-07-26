import { agentEvents, agentSessions, conversations, messages } from "db";
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { db } from "../db";
import { generateId } from "../utils";

type LegacyAgentSessionRow = typeof agentSessions.$inferSelect;

/**
 * Either the root db handle or a transaction handle. The legacy migration runs
 * every step inside one transaction so a failure part-way through cannot leave
 * a half-built conversation behind (which the next request would then migrate
 * a second time).
 */
type DbOrTx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

type AgentRunStep = {
  type: "tool_start" | "tool_result" | "error";
  toolName?: string;
  content?: string;
  toolInput?: unknown;
  createdAt?: string;
};

type AgentRunData = {
  status: "running" | "completed" | "cancelled" | "failed" | "partial";
  summary: string;
  error?: string;
  steps: AgentRunStep[];
  legacySessionId?: string;
};

function parseToolInput(raw: string | null): unknown {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function buildAgentRunSummary(steps: AgentRunStep[], error?: string) {
  const toolCount = steps.filter((step) => step.type === "tool_start").length;
  if (error) {
    return toolCount > 0 ? `Agent 运行失败，已调用 ${toolCount} 个工具` : "Agent 运行失败";
  }
  return toolCount > 0 ? `Agent 已调用 ${toolCount} 个工具` : "Agent 已完成本轮执行";
}

function mapLegacyStatus(status: string | null | undefined): AgentRunData["status"] {
  if (status === "cancelled") return "cancelled";
  if (status === "active") return "completed";
  if (status === "failed") return "failed";
  return "completed";
}

async function insertMigratedAssistantMessage(params: {
  tx: DbOrTx;
  conversationId: string;
  session: LegacyAgentSessionRow;
  content: string;
  steps: AgentRunStep[];
  error?: string;
  createdAt: Date;
}) {
  const runData: AgentRunData = {
    status: params.error ? "failed" : mapLegacyStatus(params.session.status),
    summary: buildAgentRunSummary(params.steps, params.error),
    error: params.error,
    steps: params.steps,
    legacySessionId: params.session.id,
  };

  await params.tx.insert(messages).values({
    id: generateId(),
    conversationId: params.conversationId,
    role: "assistant",
    content: params.content || params.error || "",
    model: params.session.modelId || null,
    mode: "agent",
    attachments: null,
    agentRun: JSON.stringify(runData),
    createdAt: params.createdAt,
  });
}

async function migrateSessionEventsToConversation(
  tx: DbOrTx,
  session: LegacyAgentSessionRow,
  conversationId: string,
) {
  const rows = await tx
    .select()
    .from(agentEvents)
    .where(eq(agentEvents.sessionId, session.id))
    .orderBy(asc(agentEvents.createdAt));

  let assistantText = "";
  let steps: AgentRunStep[] = [];
  let errorText: string | undefined;
  let assistantCreatedAt = session.createdAt;

  const flushAssistant = async (createdAt: Date) => {
    if (!assistantText.trim() && steps.length === 0 && !errorText) return;
    await insertMigratedAssistantMessage({
      tx,
      conversationId,
      session,
      content: assistantText,
      steps,
      error: errorText,
      createdAt,
    });
    assistantText = "";
    steps = [];
    errorText = undefined;
    assistantCreatedAt = createdAt;
  };

  for (const row of rows) {
    if (row.type === "user") {
      await flushAssistant(assistantCreatedAt);
      await tx.insert(messages).values({
        id: generateId(),
        conversationId,
        role: "user",
        content: row.content || "",
        model: null,
        mode: "agent",
        attachments: null,
        agentRun: null,
        createdAt: row.createdAt,
      });
      assistantCreatedAt = row.createdAt;
      continue;
    }

    if (row.type === "text") {
      assistantText += row.content || "";
      assistantCreatedAt = row.createdAt;
      continue;
    }

    if (row.type === "tool_start" || row.type === "tool_result") {
      steps.push({
        type: row.type,
        toolName: row.toolName || undefined,
        content: row.content || undefined,
        toolInput: parseToolInput(row.toolInput),
        createdAt: row.createdAt.toISOString(),
      });
      assistantCreatedAt = row.createdAt;
      continue;
    }

    if (row.type === "error") {
      errorText = row.content || "Agent error";
      steps.push({
        type: "error",
        content: errorText,
        createdAt: row.createdAt.toISOString(),
      });
      assistantCreatedAt = row.createdAt;
    }
  }

  await flushAssistant(session.updatedAt);
}

async function migrateLegacySession(userId: string, session: LegacyAgentSessionRow) {
  const conversationId = generateId();
  // One transaction for all three steps (create conversation → copy events →
  // mark the session migrated). Previously a failure between them left an
  // orphan conversation whose session still had conversationId = NULL, so the
  // next request migrated it again and duplicated the whole thread.
  await db.transaction(async (tx) => {
    await tx.insert(conversations).values({
      id: conversationId,
      userId,
      channelId: session.channelId || null,
      modelId: session.modelId || null,
      title: session.title,
      systemPrompt: null,
      contextLength: 4096,
      defaultMode: "agent",
      lastMode: "agent",
      isPinned: false,
      runStatus: session.status || null,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    });

    await migrateSessionEventsToConversation(tx, session, conversationId);

    await tx
      .update(agentSessions)
      .set({ conversationId })
      .where(and(eq(agentSessions.id, session.id), eq(agentSessions.userId, userId)));
  });
}

/**
 * In-flight migrations keyed by user. Two concurrent reads (the desktop client
 * fires /conversations and /conversations/:id together) would otherwise both
 * select the same conversationId-IS-NULL rows and migrate each one twice,
 * producing duplicate conversations and duplicate messages.
 */
const migrationsInFlight = new Map<string, Promise<void>>();

export async function ensureLegacyAgentSessionsMigrated(userId: string) {
  const running = migrationsInFlight.get(userId);
  if (running) return running;

  const task = (async () => {
    const sessions = await db
      .select()
      .from(agentSessions)
      .where(and(eq(agentSessions.userId, userId), isNull(agentSessions.conversationId)))
      .orderBy(asc(agentSessions.createdAt));

    for (const session of sessions) {
      await migrateLegacySession(userId, session);
    }
  })();

  migrationsInFlight.set(userId, task);
  try {
    await task;
  } finally {
    // Always release: a failed migration must be retryable on the next request.
    migrationsInFlight.delete(userId);
  }
}

export async function listUnifiedConversations(userId: string) {
  await ensureLegacyAgentSessionsMigrated(userId);
  return db
    .select()
    .from(conversations)
    .where(eq(conversations.userId, userId))
    .orderBy(desc(conversations.updatedAt));
}

export async function getUnifiedConversation(userId: string, conversationId: string) {
  await ensureLegacyAgentSessionsMigrated(userId);
  const rows = await db
    .select()
    .from(conversations)
    .where(and(eq(conversations.userId, userId), eq(conversations.id, conversationId)))
    .limit(1);
  return rows[0] || null;
}
