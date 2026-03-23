import { expect, test } from "bun:test";
import { agentEvents, agentSessions, attachments, users } from "db";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { deleteAgentSession } from "./agentService";

test("deleteAgentSession clears linked attachments before deleting the session", async () => {
  const userId = crypto.randomUUID();
  const sessionId = crypto.randomUUID();
  const eventId = crypto.randomUUID();
  const attachmentId = crypto.randomUUID();
  const now = new Date();

  await db.insert(users).values({
    id: userId,
    email: `${userId}@test.local`,
    username: "u",
    passwordHash: "x",
    createdAt: now,
    updatedAt: now,
  });

  await db.insert(agentSessions).values({
    id: sessionId,
    userId,
    conversationId: null,
    channelId: null,
    modelId: null,
    title: "session",
    status: "active",
    createdAt: now,
    updatedAt: now,
  });

  await db.insert(agentEvents).values({
    id: eventId,
    sessionId,
    type: "text",
    content: "event",
    toolName: null,
    toolInput: null,
    createdAt: now,
  });

  await db.insert(attachments).values({
    id: attachmentId,
    conversationId: null,
    sessionId,
    messageId: null,
    fileName: "session.txt",
    filePath: "/tmp/session.txt",
    fileType: "text/plain",
    fileSize: 1,
    createdAt: now,
  });

  try {
    await deleteAgentSession(userId, sessionId);

    const [sessionRows, eventRows, attachmentRows] = await Promise.all([
      db
        .select()
        .from(agentSessions)
        .where(and(eq(agentSessions.id, sessionId), eq(agentSessions.userId, userId))),
      db.select().from(agentEvents).where(eq(agentEvents.id, eventId)),
      db.select().from(attachments).where(eq(attachments.id, attachmentId)),
    ]);

    expect(sessionRows).toHaveLength(0);
    expect(eventRows).toHaveLength(0);
    expect(attachmentRows).toHaveLength(0);
  } finally {
    await db.delete(attachments).where(eq(attachments.id, attachmentId));
    await db.delete(agentEvents).where(eq(agentEvents.id, eventId));
    await db
      .delete(agentSessions)
      .where(and(eq(agentSessions.id, sessionId), eq(agentSessions.userId, userId)));
    await db.delete(users).where(eq(users.id, userId));
  }
});
