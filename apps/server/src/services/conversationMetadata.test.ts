import { expect, test } from "bun:test";
import { conversations, users } from "db";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { applyGeneratedTitle, updateConversation } from "./conversationService";
import { getUnifiedConversation, listUnifiedConversations } from "./unifiedConversationService";

test("manual rename survives stale generated titles, refresh, and desktop projection", async () => {
  const userId = crypto.randomUUID();
  const id = crypto.randomUUID();
  const dates = { createdAt: new Date(), updatedAt: new Date() };
  await db
    .insert(users)
    .values({ id: userId, email: `${userId}@test.local`, username: "title", ...dates });
  try {
    await db.insert(conversations).values({
      id,
      userId,
      title: "新会话",
      summary: "summary",
      keyFacts: "facts",
      systemPrompt: "custom prompt",
      ...dates,
    });
    expect(await applyGeneratedTitle(userId, id, "新会话", "First title")).toBe(true);
    await updateConversation(userId, id, { title: "Manual" });
    expect(await applyGeneratedTitle(userId, id, "新会话", "Outdated")).toBe(false);
    const [item] = await listUnifiedConversations(userId, true);
    expect(item).toMatchObject({ id, title: "Manual", systemPrompt: "custom prompt" });
    expect("summary" in item || "keyFacts" in item).toBe(false);
    expect((await listUnifiedConversations(userId))[0]).toMatchObject({
      id,
      title: "Manual",
      summary: "summary",
    });
    expect((await getUnifiedConversation(userId, id))?.title).toBe("Manual");
  } finally {
    await db.delete(conversations).where(eq(conversations.userId, userId));
    await db.delete(users).where(eq(users.id, userId));
  }
});
