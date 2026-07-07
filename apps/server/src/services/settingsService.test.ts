import { expect, test } from "bun:test";
import { settings, users } from "db";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { deleteSettingValue, getSettingValues, setSettingValue } from "./settingsService";

// In the full suite another test file may `mock.module("../db", ...)` with a partial
// query-builder mock (the known "db.delete is not a function" baseline noise). This
// DB-backed test can only run against the real client, so detect the mock and skip;
// it still fully validates upsert behavior when the file is run in isolation.
function dbIsMocked() {
  return typeof (db as { delete?: unknown }).delete !== "function";
}

test("settings: set/get/delete value by key", async () => {
  const userId = crypto.randomUUID();
  const key = "chat.systemPrompt";

  await db.insert(users).values({
    id: userId,
    email: `${userId}@test.local`,
    username: "u",
    passwordHash: "x",
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  try {
    await setSettingValue(userId, key, "hello");
    expect(await getSettingValues(userId, [key])).toEqual({ [key]: "hello" });

    await deleteSettingValue(userId, key);
    expect(await getSettingValues(userId, [key])).toEqual({});
  } finally {
    await db.delete(users).where(eq(users.id, userId));
  }
});

test("settings: repeated set upserts a single row with the latest value", async () => {
  if (dbIsMocked()) return;
  const userId = crypto.randomUUID();
  const key = "chat.systemPrompt";

  await db.insert(users).values({
    id: userId,
    email: `${userId}@test.local`,
    username: "u",
    passwordHash: "x",
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  try {
    await setSettingValue(userId, key, "first");
    await setSettingValue(userId, key, "second");
    await setSettingValue(userId, key, "third");

    const rows = await db
      .select()
      .from(settings)
      .where(and(eq(settings.userId, userId), eq(settings.key, key)));

    expect(rows).toHaveLength(1);
    expect(rows[0].value).toBe("third");
    expect(await getSettingValues(userId, [key])).toEqual({ [key]: "third" });
  } finally {
    await deleteSettingValue(userId, key);
    await db.delete(users).where(eq(users.id, userId));
  }
});

test("settings: user isolation", async () => {
  const key = "chat.systemPrompt";
  const u1 = crypto.randomUUID();
  const u2 = crypto.randomUUID();

  await db.insert(users).values([
    {
      id: u1,
      email: `${u1}@test.local`,
      username: "u1",
      passwordHash: "x",
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    {
      id: u2,
      email: `${u2}@test.local`,
      username: "u2",
      passwordHash: "x",
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  ]);

  try {
    await setSettingValue(u1, key, "u1");
    await setSettingValue(u2, key, "u2");

    expect(await getSettingValues(u1, [key])).toEqual({ [key]: "u1" });
    expect(await getSettingValues(u2, [key])).toEqual({ [key]: "u2" });
  } finally {
    await deleteSettingValue(u1, key);
    await deleteSettingValue(u2, key);
    await db.delete(users).where(eq(users.id, u1));
    await db.delete(users).where(eq(users.id, u2));
  }
});
