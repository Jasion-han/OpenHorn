import { describe, expect, test } from "bun:test";
import { conversations, settings, users } from "db";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { setSettingValue } from "./settingsService";
import { dropEchoes, getWelcomeSuggestions } from "./welcomeSuggestionService";

const SETTING_KEY = "welcome.suggestions";

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

async function seedConversation(userId: string, title: string) {
  const id = crypto.randomUUID();
  const now = new Date();
  await db.insert(conversations).values({
    id,
    userId,
    channelId: null,
    modelId: null,
    title,
    systemPrompt: null,
    contextLength: 4096,
    defaultMode: "agent",
    lastMode: "agent",
    isPinned: false,
    forceWebSearch: true,
    runStatus: null,
    workspaceId: null,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

async function cleanup(userId: string) {
  await db.delete(conversations).where(eq(conversations.userId, userId));
  await db.delete(settings).where(eq(settings.userId, userId));
  await db.delete(users).where(eq(users.id, userId));
}

test("returns nothing (and never blocks) when no suggestions are cached", async () => {
  const userId = await seedUser();
  try {
    // No channels are configured for this user, so the background refresh can do
    // nothing either — the caller must still get an immediate, empty answer.
    const started = Date.now();
    const result = await getWelcomeSuggestions(userId);
    expect(result.suggestions).toHaveLength(0);
    expect(result.stale).toBe(true);
    // A model round-trip would take far longer than this; the read path must not
    // be waiting on one.
    expect(Date.now() - started < 2000).toBe(true);
  } finally {
    await cleanup(userId);
  }
});

test("serves a cached set whose seed still matches the current context", async () => {
  const userId = await seedUser();
  try {
    const conversationId = await seedConversation(userId, "读一读这个仓库");
    await setSettingValue(
      userId,
      SETTING_KEY,
      JSON.stringify({
        items: ["继续昨天的重构", "跑一遍测试", "整理今天的笔记"],
        generatedAt: Date.now(),
        seed: `${conversationId}:1`,
      }),
    );

    const result = await getWelcomeSuggestions(userId);
    expect(result.suggestions).toEqual(["继续昨天的重构", "跑一遍测试", "整理今天的笔记"]);
    expect(result.stale).toBe(false);
  } finally {
    await cleanup(userId);
  }
});

test("still serves a stale set rather than showing nothing while it refreshes", async () => {
  const userId = await seedUser();
  try {
    await seedConversation(userId, "读一读这个仓库");
    await setSettingValue(
      userId,
      SETTING_KEY,
      JSON.stringify({
        items: ["旧的建议"],
        generatedAt: Date.now() - 24 * 60 * 60 * 1000,
        seed: "some-old-seed:1",
      }),
    );

    const result = await getWelcomeSuggestions(userId);
    // Marked stale (a refresh was scheduled) but the previous set is still handed
    // back, so the screen never regresses to nothing.
    expect(result.stale).toBe(true);
    expect(result.suggestions).toEqual(["旧的建议"]);
  } finally {
    await cleanup(userId);
  }
});

test("ignores a corrupted cache entry instead of throwing", async () => {
  const userId = await seedUser();
  try {
    await seedConversation(userId, "读一读这个仓库");
    await setSettingValue(userId, SETTING_KEY, "not json at all");

    const result = await getWelcomeSuggestions(userId);
    expect(result.suggestions).toHaveLength(0);
    expect(result.stale).toBe(true);
  } finally {
    await cleanup(userId);
  }
});

describe("dropEchoes", () => {
  test("drops a suggestion restating the conversation the user just created", () => {
    // The exact pair observed in the app: neither string contains the other, so a
    // substring check would have let this through.
    expect(dropEchoes(["分析特斯拉本周股价走势"], ["特斯拉股价走势如何"])).toEqual([]);
    expect(dropEchoes(["整理今天AI科技要闻"], ["整理科技要闻"])).toEqual([]);
  });

  test("keeps suggestions that head somewhere new", () => {
    const kept = dropEchoes(["给我一个Claude SDK示例", "帮我查下本周汇率"], ["特斯拉股价走势如何"]);
    expect(kept).toEqual(["给我一个Claude SDK示例", "帮我查下本周汇率"]);
  });

  test("only compares against the most recent handful of titles", () => {
    const olderTitles = ["a", "b", "c", "d", "e", "特斯拉股价走势如何"];
    // The matching title sits at index 5, past the cut-off, so the older topic is
    // allowed to come round again.
    expect(dropEchoes(["分析特斯拉本周股价走势"], olderTitles)).toHaveLength(1);
  });

  test("ignores punctuation and case differences", () => {
    expect(dropEchoes(["Claude SDK 用法？"], ["claude sdk用法"])).toEqual([]);
  });
});
