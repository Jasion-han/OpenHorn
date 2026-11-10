import { expect, test } from "bun:test";
import {
  conversations,
  messages,
  projects,
  savedArtifacts,
  savedArtifactVersions,
  users,
} from "db";
import { eq } from "drizzle-orm";
import { client, db } from "../db";
import { bootstrapDatabase } from "../db/bootstrap";
import {
  appendArtifactVersion,
  createArtifact,
  deleteArtifact,
  getArtifactDetail,
  listArtifacts,
  restoreArtifact,
  updateArtifact,
} from "./artifactService";
import { applyConversationDeletion, planConversationDeletion } from "./conversationService";

test("restoring an artifact copies immutable history, preserves newer versions and rejects stale/foreign writes", async () => {
  const f = await fixture();
  try {
    const first = await createArtifact(f.userId, { sourceMessageId: f.sourceMessageId });
    await appendArtifactVersion(f.userId, first.artifact.id, {
      expectedVersion: 1,
      content: "Newer content",
      format: "html",
    });
    await db
      .update(messages)
      .set({ content: "The source has since changed" })
      .where(eq(messages.id, f.sourceMessageId));
    const restored = await restoreArtifact(f.userId, first.artifact.id, 1, 2);
    expect(restored.version.content).toBe(first.version.content);
    expect(restored.version.format).toBe("markdown");
    expect(restored.version.version).toBe(3);
    expect(restored.version.sourceMessageId).toBe(null);
    expect((await getArtifactDetail(f.userId, first.artifact.id, 2)).version.content).toBe(
      "Newer content",
    );
    expect(await restoreArtifact("other-user", first.artifact.id, 1, 3).catch((e) => e.code)).toBe(
      "artifact_not_found",
    );
    expect(await restoreArtifact(f.userId, first.artifact.id, 1, 2).catch((e) => e.code)).toBe(
      "artifact_version_conflict",
    );
    expect(await restoreArtifact(f.userId, first.artifact.id, "1", 3).catch((e) => e.code)).toBe(
      "invalid_artifact",
    );
    await db.delete(messages).where(eq(messages.id, f.sourceMessageId));
    const again = await restoreArtifact(f.userId, first.artifact.id, 1, 3);
    expect(again.version.content).toBe(first.version.content);
    expect((await getArtifactDetail(f.userId, first.artifact.id)).versions).toHaveLength(4);
  } finally {
    await f.close();
  }
});

async function fixture() {
  const userId = crypto.randomUUID();
  const projectId = crypto.randomUUID();
  const conversationId = crypto.randomUUID();
  const sourceMessageId = crypto.randomUUID();
  const now = new Date();
  await db.insert(users).values({
    id: userId,
    email: `${userId}@artifact.test.invalid`,
    username: "artifact",
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(projects).values({
    id: projectId,
    userId,
    name: "Source project",
    rootPath: `/synthetic/${projectId}`,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(conversations).values({
    id: conversationId,
    userId,
    projectId,
    title: "Source conversation",
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(messages).values({
    id: sourceMessageId,
    conversationId,
    role: "assistant",
    content: "  # 原文\r\n\r\n表格 | 值\r\n--- | ---\r\n甲 | 42\r\n  ",
    mode: "chat",
    createdAt: now,
  });
  return {
    userId,
    projectId,
    conversationId,
    sourceMessageId,
    close: async () => {
      await db.delete(savedArtifacts).where(eq(savedArtifacts.userId, userId));
      await db.delete(conversations).where(eq(conversations.userId, userId));
      await db.delete(projects).where(eq(projects.userId, userId));
      await db.delete(users).where(eq(users.id, userId));
    },
  };
}

test("source saves preserve complete canonical text and metadata without trusting client content", async () => {
  const f = await fixture();
  try {
    const saved = await createArtifact(f.userId, {
      sourceMessageId: f.sourceMessageId,
      content: "untrusted replacement",
    });
    expect(saved.artifact.title).toBe("Source conversation");
    expect(saved.artifact.projectId).toBe(f.projectId);
    expect(saved.artifact.currentVersion).toBe(1);
    expect(saved.version.content).toBe("  # 原文\r\n\r\n表格 | 值\r\n--- | ---\r\n甲 | 42\r\n  ");
    expect(saved.version.sourceConversationId).toBe(f.conversationId);
    expect(saved.version.sourceMessageId).toBe(f.sourceMessageId);
    expect(saved.version.format).toBe("markdown");
    expect(new Date(saved.artifact.createdAt).toISOString()).toBe(saved.artifact.createdAt);
    expect(Object.keys(saved.artifact).sort()).toEqual(
      ["id", "title", "projectId", "currentVersion", "createdAt", "updatedAt"].sort(),
    );
    await db
      .update(messages)
      .set({
        content: "stale cached content",
        agentRun: JSON.stringify({
          status: "completed",
          steps: [
            { type: "thinking", content: "private reasoning" },
            { type: "text", content: " First canonical step " },
            { type: "tool", content: "private output" },
            { type: "text", content: "Second canonical step" },
          ],
        }),
      })
      .where(eq(messages.id, f.sourceMessageId));
    const agent = await createArtifact(f.userId, { sourceMessageId: f.sourceMessageId });
    expect(agent.version.content).toBe("First canonical step\n\nSecond canonical step");
  } finally {
    await f.close();
  }
});

test("unfinished, missing, foreign and user-role message sources reject without creating artifacts", async () => {
  const f = await fixture();
  const other = await fixture();
  try {
    for (const status of ["running", "awaiting_approval"]) {
      await db
        .update(messages)
        .set({
          agentRun: JSON.stringify({ status, steps: [{ type: "text", content: "partial" }] }),
        })
        .where(eq(messages.id, f.sourceMessageId));
      await expect(
        createArtifact(f.userId, { sourceMessageId: f.sourceMessageId, content: "forged final" }),
      ).rejects.toMatchObject({ code: "source_not_ready" });
    }
    await db.update(messages).set({ role: "user" }).where(eq(messages.id, f.sourceMessageId));
    for (const sourceMessageId of [f.sourceMessageId, other.sourceMessageId, crypto.randomUUID()]) {
      await expect(createArtifact(f.userId, { sourceMessageId })).rejects.toMatchObject({
        code: "source_not_found",
      });
    }
    expect(await listArtifacts(f.userId)).toHaveLength(0);
  } finally {
    await f.close();
    await other.close();
  }
});

test("explicit content, format and the UTF-8 size boundary preserve original text", async () => {
  const f = await fixture();
  try {
    for (const [format, content] of [
      ["html", "<style>p{color:red}</style>\r\n<p>你好</p>\n"],
      ["openui", 'root = Card(children=[Text("你好")])\n'],
      ["markdown", `${"x".repeat(2 * 1024 * 1024 - 1)}\n`],
    ] as const) {
      const saved = await createArtifact(f.userId, { title: "Raw", format, content });
      expect(saved.version.content).toBe(content);
      expect(saved.version.format).toBe(format);
      expect(saved.version.sourceMessageId).toBe(null);
    }
    for (const input of [
      null,
      [],
      {},
      { content: "\n\t" },
      { content: "x".repeat(2 * 1024 * 1024 + 1) },
      { content: "你".repeat(Math.floor((2 * 1024 * 1024) / 3) + 1) },
      { content: "hello", format: "javascript" },
      { content: "hello", title: " " },
      { content: "hello", projectId: false },
    ]) {
      await expect(createArtifact(f.userId, input)).rejects.toMatchObject({
        code: "invalid_artifact",
      });
    }
  } finally {
    await f.close();
  }
});

test("all artifact operations and source/project references are owner scoped", async () => {
  const f = await fixture();
  const other = await fixture();
  try {
    const saved = await createArtifact(f.userId, { content: "owned", projectId: f.projectId });
    expect(await listArtifacts(other.userId)).toEqual([]);
    for (const action of [
      () => getArtifactDetail(other.userId, saved.artifact.id),
      () =>
        appendArtifactVersion(other.userId, saved.artifact.id, {
          expectedVersion: 1,
          content: "x",
        }),
      () => updateArtifact(other.userId, saved.artifact.id, { title: "stolen" }),
      () => deleteArtifact(other.userId, saved.artifact.id),
    ]) {
      await expect(action()).rejects.toMatchObject({ code: "artifact_not_found" });
    }
    await expect(
      createArtifact(f.userId, { content: "x", projectId: other.projectId }),
    ).rejects.toMatchObject({ code: "project_not_found" });
    await expect(
      updateArtifact(f.userId, saved.artifact.id, { title: "x", projectId: other.projectId }),
    ).rejects.toMatchObject({ code: "project_not_found" });
    await expect(
      appendArtifactVersion(f.userId, saved.artifact.id, {
        expectedVersion: 1,
        sourceMessageId: other.sourceMessageId,
      }),
    ).rejects.toMatchObject({ code: "source_not_found" });
    expect((await getArtifactDetail(f.userId, saved.artifact.id)).version.content).toBe("owned");
  } finally {
    await f.close();
    await other.close();
  }
});

test("concurrent expectedVersion updates append one immutable version and return a conflict", async () => {
  const f = await fixture();
  try {
    const saved = await createArtifact(f.userId, { content: "version one" });
    const attempts = await Promise.allSettled([
      appendArtifactVersion(f.userId, saved.artifact.id, {
        expectedVersion: 1,
        content: "version two A",
      }),
      appendArtifactVersion(f.userId, saved.artifact.id, {
        expectedVersion: 1,
        content: "version two B",
      }),
    ]);
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    const failure = attempts.find((attempt) => attempt.status === "rejected");
    expect(failure?.status === "rejected" ? failure.reason.code : null).toBe(
      "artifact_version_conflict",
    );
    const detail = await getArtifactDetail(f.userId, saved.artifact.id);
    expect(detail.artifact.currentVersion).toBe(2);
    expect(detail.versions.map((version) => version.version)).toEqual([2, 1]);
    expect(detail.versions.every((version) => !("content" in version))).toBe(true);
    expect((await getArtifactDetail(f.userId, saved.artifact.id, 1)).version.content).toBe(
      "version one",
    );
    await expect(
      appendArtifactVersion(f.userId, saved.artifact.id, { expectedVersion: 1, content: "late" }),
    ).rejects.toMatchObject({ code: "artifact_version_conflict" });
  } finally {
    await f.close();
  }
});

test("source message, conversation and project deletion leave independent saved versions intact", async () => {
  const f = await fixture();
  try {
    const saved = await createArtifact(f.userId, { sourceMessageId: f.sourceMessageId });
    await db.delete(messages).where(eq(messages.id, f.sourceMessageId));
    let detail = await getArtifactDetail(f.userId, saved.artifact.id);
    expect(detail.version.sourceMessageId).toBe(null);
    expect(detail.version.sourceConversationId).toBe(f.conversationId);
    const plan = await planConversationDeletion(f.userId, f.conversationId);
    if (!plan) throw new Error("Missing synthetic deletion plan");
    await db.transaction((tx) => applyConversationDeletion(tx, plan));
    await db.delete(projects).where(eq(projects.id, f.projectId));
    detail = await getArtifactDetail(f.userId, saved.artifact.id);
    expect(detail.artifact.projectId).toBe(null);
    expect(detail.version.sourceMessageId).toBe(null);
    expect(detail.version.sourceConversationId).toBe(null);
    expect(detail.version.content).toBe(saved.version.content);
    await bootstrapDatabase();
    expect((await getArtifactDetail(f.userId, saved.artifact.id)).version.content).toBe(
      saved.version.content,
    );
  } finally {
    await f.close();
  }
});

test("version insert failure rolls back the artifact CAS, and metadata edits never alter versions", async () => {
  const f = await fixture();
  const trigger = `artifact_failure_${crypto.randomUUID().replaceAll("-", "")}`;
  try {
    const saved = await createArtifact(f.userId, { content: "immutable" });
    await client.execute(
      `CREATE TRIGGER ${trigger} BEFORE INSERT ON saved_artifact_versions WHEN NEW.artifact_id = '${saved.artifact.id}' AND NEW.version = 2 BEGIN SELECT RAISE(ABORT, 'synthetic artifact failure'); END`,
    );
    await expect(
      appendArtifactVersion(f.userId, saved.artifact.id, {
        expectedVersion: 1,
        content: "replacement",
      }),
    ).rejects.toThrow();
    expect((await getArtifactDetail(f.userId, saved.artifact.id)).artifact.currentVersion).toBe(1);
    const renamed = await updateArtifact(f.userId, saved.artifact.id, {
      title: "Renamed",
      projectId: f.projectId,
    });
    expect(renamed.title).toBe("Renamed");
    expect(renamed.projectId).toBe(f.projectId);
    expect((await getArtifactDetail(f.userId, saved.artifact.id)).version.content).toBe(
      "immutable",
    );
    await deleteArtifact(f.userId, saved.artifact.id);
    expect(
      await db
        .select()
        .from(savedArtifactVersions)
        .where(eq(savedArtifactVersions.artifactId, saved.artifact.id)),
    ).toHaveLength(0);
    await expect(getArtifactDetail(f.userId, saved.artifact.id)).rejects.toMatchObject({
      code: "artifact_not_found",
    });
  } finally {
    await client.execute(`DROP TRIGGER IF EXISTS ${trigger}`);
    await f.close();
  }
});
