import { describe, expect, test } from "bun:test";
import { agentEvents, agentSessions, conversations, messages, users } from "db";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db";
import { bootstrapDatabase } from "../db/bootstrap";
import { generateId } from "../utils";
import { ensureLegacyAgentSessionsMigrated } from "./unifiedConversationService";

/** agent_sessions.user_id has an FK to users, so the owner must exist first. */
async function seedUser() {
  const userId = generateId();
  const now = new Date();
  await db.insert(users).values({
    id: userId,
    email: `${userId}@test.local`,
    username: "migration-test",
    passwordHash: "x",
    createdAt: now,
    updatedAt: now,
  });
  return userId;
}

async function seedLegacySession(userId: string) {
  const sessionId = generateId();
  const now = new Date();
  await db.insert(agentSessions).values({
    id: sessionId,
    userId,
    title: "legacy thread",
    status: "completed",
    conversationId: null,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(agentEvents).values({
    id: generateId(),
    sessionId,
    type: "user",
    content: "hello from the legacy session",
    createdAt: now,
  });
  return sessionId;
}

describe("ensureLegacyAgentSessionsMigrated", () => {
  test("migrates a legacy session exactly once", async () => {
    await bootstrapDatabase();
    const userId = await seedUser();
    await seedLegacySession(userId);

    await ensureLegacyAgentSessionsMigrated(userId);

    const rows = await db.select().from(conversations).where(eq(conversations.userId, userId));
    expect(rows).toHaveLength(1);
  });

  // Two concurrent reads used to each select the same conversationId-IS-NULL
  // rows and migrate them, duplicating both the conversation and its messages.
  test("concurrent calls do not duplicate the conversation", async () => {
    await bootstrapDatabase();
    const userId = await seedUser();
    await seedLegacySession(userId);

    await Promise.all([
      ensureLegacyAgentSessionsMigrated(userId),
      ensureLegacyAgentSessionsMigrated(userId),
      ensureLegacyAgentSessionsMigrated(userId),
    ]);

    const convos = await db.select().from(conversations).where(eq(conversations.userId, userId));
    expect(convos).toHaveLength(1);

    const conversationId = String(convos[0]?.id);
    const msgs = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conversationId));
    expect(msgs).toHaveLength(1);
  });

  test("a migrated session is not picked up again", async () => {
    await bootstrapDatabase();
    const userId = await seedUser();
    await seedLegacySession(userId);

    await ensureLegacyAgentSessionsMigrated(userId);
    await ensureLegacyAgentSessionsMigrated(userId);

    const convos = await db.select().from(conversations).where(eq(conversations.userId, userId));
    expect(convos).toHaveLength(1);

    const pending = await db
      .select()
      .from(agentSessions)
      .where(and(eq(agentSessions.userId, userId), isNull(agentSessions.conversationId)));
    expect(pending).toHaveLength(0);
  });

  test("assistant replies become text steps in timeline order; failures stay out of content", async () => {
    await bootstrapDatabase();
    const userId = await seedUser();
    const sessionId = await seedLegacySession(userId);
    const at = (offset: number) => new Date(Date.now() + offset * 1000);
    const events = [
      { type: "text", content: "Let me ", createdAt: at(1) },
      { type: "text", content: "check.", createdAt: at(2) },
      { type: "tool_start", content: null, toolName: "Bash", createdAt: at(3) },
      { type: "text", content: "Done.", createdAt: at(4) },
      { type: "user", content: "again", createdAt: at(5) },
      { type: "error", content: "boom", createdAt: at(6) },
    ];
    for (const event of events) {
      await db.insert(agentEvents).values({ id: generateId(), sessionId, ...event });
    }

    await ensureLegacyAgentSessionsMigrated(userId);

    const [conversation] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.userId, userId));
    const rows = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, String(conversation?.id)));
    const runs = rows
      .filter((row) => row.role === "assistant")
      .map((row) => ({ content: row.content, run: JSON.parse(String(row.agentRun)) }));
    expect(runs).toHaveLength(2);
    const replied = runs.find((item) => item.run.status !== "failed");
    const failedRow = runs.find((item) => item.run.status === "failed");

    expect(replied?.run.steps.map((step: { type: string }) => step.type)).toEqual([
      "text",
      "tool_start",
      "text",
    ]);
    expect(replied?.content).toBe("Let me check.\n\nDone.");

    expect(failedRow?.run).toMatchObject({ status: "failed", error: "boom" });
    expect(failedRow?.content).toBe("");
  });
});
