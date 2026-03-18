import { settings } from "db";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db";
import { generateId } from "../utils";

export async function getSettingValues(userId: string, keys: string[]) {
  if (!Array.isArray(keys) || keys.length === 0) return {};

  const normalizedKeys = keys
    .map((k) => (typeof k === "string" ? k.trim() : ""))
    .filter((k) => k.length > 0);

  if (normalizedKeys.length === 0) return {};

  const rows = await db
    .select()
    .from(settings)
    .where(and(eq(settings.userId, userId), inArray(settings.key, normalizedKeys)));

  const out: Record<string, string> = {};
  for (const row of rows) {
    out[row.key] = row.value;
  }
  return out;
}

export async function setSettingValue(userId: string, key: string, value: string) {
  const normalizedKey = key.trim();
  if (!normalizedKey) {
    throw new Error("key is required");
  }

  const normalizedValue = value;
  const now = new Date();

  // Keep it simple: delete then insert. This avoids requiring a unique index.
  await db
    .delete(settings)
    .where(and(eq(settings.userId, userId), eq(settings.key, normalizedKey)));
  await db.insert(settings).values({
    id: generateId(),
    userId,
    key: normalizedKey,
    value: normalizedValue,
    updatedAt: now,
  });
}

export async function deleteSettingValue(userId: string, key: string) {
  const normalizedKey = key.trim();
  if (!normalizedKey) return;
  await db
    .delete(settings)
    .where(and(eq(settings.userId, userId), eq(settings.key, normalizedKey)));
}
