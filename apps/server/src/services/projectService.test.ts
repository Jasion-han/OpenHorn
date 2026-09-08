import { expect, test } from "bun:test";
import { attachments, conversations, messages, projects, users } from "db";
import { eq, inArray } from "drizzle-orm";
import { client, db } from "../db";
import { createConversation, updateConversation } from "./conversationService";
import { createProject, deleteProject, listProjects, updateProject } from "./projectService";

const DEFAULT_TITLE = "新会话";

async function seedUser() {
  const userId = crypto.randomUUID();
  const now = new Date();
  await db.insert(users).values({
    id: userId,
    email: `${userId}@test.local`,
    username: "u",
    passwordHash: "x",
    createdAt: now,
    updatedAt: now,
  });
  return userId;
}

async function cleanup(userId: string) {
  const rows = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(eq(conversations.userId, userId));
  for (const row of rows) {
    await db.delete(attachments).where(eq(attachments.conversationId, row.id));
    await db.delete(messages).where(eq(messages.conversationId, row.id));
  }
  await db.delete(conversations).where(eq(conversations.userId, userId));
  await db.delete(projects).where(eq(projects.userId, userId));
  await db.delete(users).where(eq(users.id, userId));
}

test("createProject dedupes on rootPath and listProjects orders starred first then by name", async () => {
  const userId = await seedUser();
  try {
    const a = await createProject(userId, { name: "beta", rootPath: `/tmp/${userId}/beta` });
    const again = await createProject(userId, { name: "beta-2", rootPath: `/tmp/${userId}/beta` });
    expect(again.id).toBe(a.id);

    const b = await createProject(userId, { name: "alpha", rootPath: `/tmp/${userId}/alpha` });
    const c = await createProject(userId, { name: "zeta", rootPath: `/tmp/${userId}/zeta` });
    await updateProject(userId, c.id, { isStarred: true });

    const listed = await listProjects(userId);
    expect(listed.map((p) => p.id)).toEqual([c.id, b.id, a.id]);
  } finally {
    await cleanup(userId);
  }
});

test("updateProject only touches the caller's own project", async () => {
  const owner = await seedUser();
  const other = await seedUser();
  try {
    const p = await createProject(owner, { name: "mine", rootPath: `/tmp/${owner}/mine` });
    const denied = await updateProject(other, p.id, { name: "hijacked" });
    expect(denied).toBe(null);
    const renamed = await updateProject(owner, p.id, { name: "renamed" });
    expect(renamed?.name).toBe("renamed");
  } finally {
    await cleanup(owner);
    await cleanup(other);
  }
});

test("deleteProject deletes the conversations filed under it", async () => {
  const userId = await seedUser();
  try {
    const p = await createProject(userId, { name: "p", rootPath: `/tmp/${userId}/p` });
    const filed = await createConversation(userId, { title: "filed", projectId: p.id });
    const plain = await createConversation(userId, { title: "plain" });
    expect(filed.projectId).toBe(p.id);

    const messageId = crypto.randomUUID();
    await db.insert(messages).values({
      id: messageId,
      conversationId: filed.id,
      role: "user",
      content: "hello",
      createdAt: new Date(),
    });

    const removed = await deleteProject(userId, p.id);
    expect(removed).toBe(true);

    const filedRows = await db.select().from(conversations).where(eq(conversations.id, filed.id));
    expect(filedRows).toHaveLength(0);
    const messageRows = await db.select().from(messages).where(eq(messages.id, messageId));
    expect(messageRows).toHaveLength(0);
    const plainRows = await db.select().from(conversations).where(eq(conversations.id, plain.id));
    expect(plainRows).toHaveLength(1);
    expect(await listProjects(userId)).toHaveLength(0);
  } finally {
    await cleanup(userId);
  }
});

/** A filed conversation with one message and one attachment (local marker → no unlink). */
async function seedFiledConversation(userId: string, projectId: string, title: string) {
  const conv = await createConversation(userId, { title, projectId });
  const messageId = crypto.randomUUID();
  const attachmentId = crypto.randomUUID();
  const now = new Date();
  await db.insert(messages).values({
    id: messageId,
    conversationId: conv.id,
    role: "user",
    content: `hello ${title}`,
    createdAt: now,
  });
  await db.insert(attachments).values({
    id: attachmentId,
    conversationId: conv.id,
    messageId,
    fileName: "a.txt",
    filePath: "local:test",
    fileType: "text/plain",
    fileSize: 1,
    createdAt: now,
  });
  return { conversationId: conv.id, messageId, attachmentId };
}

async function countRowsFor(
  seeds: { conversationId: string; messageId: string; attachmentId: string }[],
) {
  const convIds = seeds.map((s) => s.conversationId);
  const messageIds = seeds.map((s) => s.messageId);
  const attachmentIds = seeds.map((s) => s.attachmentId);
  const [convRows, messageRows, attachmentRows] = await Promise.all([
    db
      .select({ id: conversations.id })
      .from(conversations)
      .where(inArray(conversations.id, convIds)),
    db.select({ id: messages.id }).from(messages).where(inArray(messages.id, messageIds)),
    db
      .select({ id: attachments.id })
      .from(attachments)
      .where(inArray(attachments.id, attachmentIds)),
  ]);
  return {
    conversations: convRows.length,
    messages: messageRows.length,
    attachments: attachmentRows.length,
  };
}

test("deleteProject removes every filed conversation's rows and leaves the plain one alone", async () => {
  const userId = await seedUser();
  try {
    const p = await createProject(userId, { name: "p", rootPath: `/tmp/${userId}/p` });
    const seeds = [
      await seedFiledConversation(userId, p.id, "one"),
      await seedFiledConversation(userId, p.id, "two"),
      await seedFiledConversation(userId, p.id, "three"),
    ];
    const plain = await createConversation(userId, { title: "plain" });
    expect(await countRowsFor(seeds)).toEqual({ conversations: 3, messages: 3, attachments: 3 });

    expect(await deleteProject(userId, p.id)).toBe(true);

    expect(await countRowsFor(seeds)).toEqual({ conversations: 0, messages: 0, attachments: 0 });
    const plainRows = await db.select().from(conversations).where(eq(conversations.id, plain.id));
    expect(plainRows).toHaveLength(1);
    expect(await listProjects(userId)).toHaveLength(0);
  } finally {
    await cleanup(userId);
  }
});

test("deleteProject is atomic: a failure midway leaves every conversation and the project in place", async () => {
  const userId = await seedUser();
  // Data-level failure injection: a temporary trigger aborts the DELETE of the
  // second conversation, after the first conversation's rows were already
  // deleted inside the same transaction. No mocks, no production seams.
  const triggerName = `t_abort_${userId.replace(/-/g, "")}`;
  try {
    const p = await createProject(userId, { name: "p", rootPath: `/tmp/${userId}/p` });
    const seeds = [
      await seedFiledConversation(userId, p.id, "one"),
      await seedFiledConversation(userId, p.id, "two"),
      await seedFiledConversation(userId, p.id, "three"),
    ];
    const victim = seeds[1].conversationId;
    await client.execute(
      `CREATE TRIGGER ${triggerName} BEFORE DELETE ON conversations
       WHEN OLD.id = '${victim}'
       BEGIN SELECT RAISE(ABORT, 'injected failure'); END`,
    );

    let failed = false;
    try {
      await deleteProject(userId, p.id);
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);

    // Rolled back: nothing from any conversation is gone, the project is still there.
    expect(await countRowsFor(seeds)).toEqual({ conversations: 3, messages: 3, attachments: 3 });
    expect((await listProjects(userId)).map((row) => row.id)).toEqual([p.id]);

    // With the fault removed the same call succeeds and cleans everything up.
    await client.execute(`DROP TRIGGER IF EXISTS ${triggerName}`);
    expect(await deleteProject(userId, p.id)).toBe(true);
    expect(await countRowsFor(seeds)).toEqual({ conversations: 0, messages: 0, attachments: 0 });
    expect(await listProjects(userId)).toHaveLength(0);
  } finally {
    await client.execute(`DROP TRIGGER IF EXISTS ${triggerName}`);
    await cleanup(userId);
  }
});

test("blank-conversation reuse is scoped per project", async () => {
  const userId = await seedUser();
  try {
    const p1 = await createProject(userId, { name: "p1", rootPath: `/tmp/${userId}/p1` });
    const p2 = await createProject(userId, { name: "p2", rootPath: `/tmp/${userId}/p2` });

    const plain = await createConversation(userId, { title: DEFAULT_TITLE });
    const inP1 = await createConversation(userId, { title: DEFAULT_TITLE, projectId: p1.id });
    const inP2 = await createConversation(userId, { title: DEFAULT_TITLE, projectId: p2.id });

    // Three distinct scopes → three distinct blank rows.
    expect(new Set([plain.id, inP1.id, inP2.id]).size).toBe(3);

    // Same scope → reused.
    const plainAgain = await createConversation(userId, { title: DEFAULT_TITLE });
    const inP1Again = await createConversation(userId, { title: DEFAULT_TITLE, projectId: p1.id });
    expect(plainAgain.id).toBe(plain.id);
    expect(inP1Again.id).toBe(inP1.id);
  } finally {
    await cleanup(userId);
  }
});

test("updateConversation moves a conversation between projects and back to the plain list", async () => {
  const userId = await seedUser();
  try {
    const p1 = await createProject(userId, { name: "p1", rootPath: `/tmp/${userId}/p1` });
    const conv = await createConversation(userId, { title: "move me" });

    await updateConversation(userId, conv.id, { projectId: p1.id });
    let rows = await db.select().from(conversations).where(eq(conversations.id, conv.id));
    expect(rows[0].projectId).toBe(p1.id);

    await updateConversation(userId, conv.id, { projectId: null });
    rows = await db.select().from(conversations).where(eq(conversations.id, conv.id));
    expect(rows[0].projectId).toBe(null);
  } finally {
    await cleanup(userId);
  }
});
