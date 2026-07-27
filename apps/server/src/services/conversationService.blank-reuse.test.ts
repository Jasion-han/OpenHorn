import { expect, test } from "bun:test";
import { channels, conversations, messages, users } from "db";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { createConversation } from "./conversationService";

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

/** conversations.channel_id has a real FK, so an adopted channel must exist. */
async function seedChannel(userId: string) {
  const channelId = crypto.randomUUID();
  const now = new Date();
  await db.insert(channels).values({
    id: channelId,
    userId,
    name: "test-channel",
    provider: "openai",
    protocol: "openai",
    apiKey: "x",
    createdAt: now,
    updatedAt: now,
  });
  return channelId;
}

async function cleanup(userId: string) {
  const rows = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(eq(conversations.userId, userId));
  for (const row of rows) {
    await db.delete(messages).where(eq(messages.conversationId, row.id));
  }
  await db.delete(conversations).where(eq(conversations.userId, userId));
  await db.delete(channels).where(eq(channels.userId, userId));
  await db.delete(users).where(eq(users.id, userId));
}

test("createConversation reuses the existing blank conversation instead of piling up new ones", async () => {
  const userId = await seedUser();
  try {
    const first = await createConversation(userId, { title: DEFAULT_TITLE });
    const second = await createConversation(userId, { title: DEFAULT_TITLE });
    const third = await createConversation(userId, { title: DEFAULT_TITLE });

    expect(second.id).toBe(first.id);
    expect(third.id).toBe(first.id);

    const rows = await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(eq(conversations.userId, userId));
    expect(rows).toHaveLength(1);
  } finally {
    await cleanup(userId);
  }
});

test("reuse adopts the settings passed on the later call", async () => {
  const userId = await seedUser();
  try {
    const channelId = await seedChannel(userId);
    const first = await createConversation(userId, {
      title: DEFAULT_TITLE,
      defaultMode: "agent",
      forceWebSearch: true,
    });
    const second = await createConversation(userId, {
      title: DEFAULT_TITLE,
      channelId,
      modelId: "model-1",
      defaultMode: "chat",
      forceWebSearch: false,
    });

    expect(second.id).toBe(first.id);
    expect(second.defaultMode).toBe("chat");
    expect(second.lastMode).toBe("chat");
    expect(second.forceWebSearch).toBe(false);
    expect(second.channelId).toBe(channelId);
    expect(second.modelId).toBe("model-1");

    // The persisted row must match what was returned, not just the return value.
    const [stored] = await db.select().from(conversations).where(eq(conversations.id, first.id));
    expect(stored?.defaultMode).toBe("chat");
    expect(stored?.forceWebSearch).toBe(false);
    expect(stored?.channelId).toBe(channelId);
  } finally {
    await cleanup(userId);
  }
});

test("a conversation that already has a message never blocks creating a new one", async () => {
  const userId = await seedUser();
  try {
    const first = await createConversation(userId, { title: DEFAULT_TITLE });
    const now = new Date();
    await db.insert(messages).values({
      id: crypto.randomUUID(),
      conversationId: first.id,
      role: "user",
      content: "hello",
      model: null,
      mode: "chat",
      attachments: null,
      agentRun: null,
      createdAt: now,
    });

    const second = await createConversation(userId, { title: DEFAULT_TITLE });
    expect(second.id === first.id).toBe(false);

    const rows = await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(eq(conversations.userId, userId));
    expect(rows).toHaveLength(2);
  } finally {
    await cleanup(userId);
  }
});

test("a renamed blank conversation is not hijacked by the next default-titled create", async () => {
  const userId = await seedUser();
  try {
    const renamed = await createConversation(userId, { title: "读书笔记" });
    const fresh = await createConversation(userId, { title: DEFAULT_TITLE });

    expect(fresh.id === renamed.id).toBe(false);
    expect(fresh.title).toBe(DEFAULT_TITLE);
  } finally {
    await cleanup(userId);
  }
});
