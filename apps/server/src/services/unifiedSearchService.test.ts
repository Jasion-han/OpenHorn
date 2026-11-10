import { expect, test } from "bun:test";
import {
  conversations,
  messages,
  projects,
  reviewWorkspaces,
  savedArtifacts,
  taskRecipes,
  users,
} from "db";
import { eq } from "drizzle-orm";
import { createReviewData } from "shared/reviews";
import { client, db } from "../db";
import { createArtifact } from "./artifactService";
import { createRecipe } from "./recipeService";
import { unifiedSearch } from "./unifiedSearchService";

test("unified search covers owned current objects, handles literal punctuation and bounds every group", async () => {
  const a = crypto.randomUUID(),
    b = crypto.randomUUID(),
    now = new Date();
  try {
    for (const id of [a, b]) {
      await db.insert(users).values({
        id,
        email: `${id}@search.invalid`,
        username: "Synthetic",
        createdAt: now,
        updatedAt: now,
      });
      await db.insert(conversations).values({
        id: `conv-${id}`,
        userId: id,
        title: "Needle conversation",
        createdAt: now,
        updatedAt: now,
      });
      await db.insert(messages).values({
        id: `msg-${id}`,
        conversationId: `conv-${id}`,
        role: "assistant",
        content: "Needle text with 100% and _ literal",
        createdAt: now,
      });
      await db.insert(projects).values({
        id: `project-${id}`,
        userId: id,
        name: "Needle project",
        rootPath: `/synthetic/${id}`,
        createdAt: now,
        updatedAt: now,
      });
      await createArtifact(id, {
        title: "Needle artifact",
        content: `Needle ${id}`,
        format: "markdown",
      });
      await createRecipe(id, {
        title: "Needle recipe",
        description: "Synthetic",
        promptTemplate: "Needle task",
        parameters: [],
        requirements: { skills: [], mcpServers: [], workspace: false, webSearch: false },
        outputFormat: "markdown",
      });
      await db.insert(reviewWorkspaces).values({
        id: `reviews-${id}`,
        userId: id,
        title: "Needle reviews",
        data: JSON.stringify(
          createReviewData({
            csv: "text\nExample",
            fileName: "synthetic.csv",
            delimiter: ",",
            textColumn: 0,
            ratingColumn: null,
          }),
        ),
        createdAt: now,
        updatedAt: now,
      });
    }
    const results = await unifiedSearch(a, "needle");
    expect([...new Set(results.map((r) => r.kind))].sort()).toEqual([
      "artifact",
      "conversation",
      "message",
      "project",
      "recipe",
      "reviews",
    ]);
    expect(results.some((r) => r.id.includes(b) || r.snippet.includes(b))).toBe(false);
    await client.execute({
      sql: "INSERT INTO messages_fts(message_id,conversation_id,content) VALUES(?,?,?)",
      args: [`msg-${a}`, `conv-${a}`, "Needle text with 100% and _ literal"],
    });
    await db.insert(messages).values({
      id: `long-${a}`,
      conversationId: `conv-${a}`,
      role: "assistant",
      content: `${"x".repeat(5001)}needle`,
      createdAt: now,
    });
    await client.execute({
      sql: "INSERT INTO messages_fts(message_id,conversation_id,content) VALUES(?,?,?)",
      args: [`long-${a}`, `conv-${a}`, "x".repeat(5000)],
    });
    expect((await unifiedSearch(a, "needle")).some((r) => r.id === `long-${a}`)).toBe(true);
    expect((await unifiedSearch(a, "%")).map((r) => r.id)).toEqual([`msg-${a}`]);
    expect((await unifiedSearch(a, "_")).map((r) => r.id)).toEqual([`msg-${a}`]);
    expect(await unifiedSearch(a, "  ")).toEqual([]);
    expect(await unifiedSearch(a, "x".repeat(201)).catch((e) => e.message)).toBe(
      "search_query_limit",
    );
    for (let i = 0; i < 12; i++)
      await db.insert(conversations).values({
        id: `${a}-${i}`,
        userId: a,
        title: "Needle extra",
        createdAt: now,
        updatedAt: now,
      });
    expect(
      (await unifiedSearch(a, "needle")).filter((r) => r.kind === "conversation"),
    ).toHaveLength(8);
  } finally {
    for (const id of [a, b]) {
      await client.execute({
        sql: "DELETE FROM messages_fts WHERE conversation_id=?",
        args: [`conv-${id}`],
      });
      await db.delete(savedArtifacts).where(eq(savedArtifacts.userId, id));
      await db.delete(taskRecipes).where(eq(taskRecipes.userId, id));
      await db.delete(reviewWorkspaces).where(eq(reviewWorkspaces.userId, id));
      await db.delete(conversations).where(eq(conversations.userId, id));
      await db.delete(projects).where(eq(projects.userId, id));
      await db.delete(users).where(eq(users.id, id));
    }
  }
});
