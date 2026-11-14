import { settings } from "db";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db";
import { decrypt, encrypt, generateId } from "../utils";

const TOOLS_KEY = "deepseek.toolsApiKey";

export async function getSettingValues(userId: string, keys: string[]) {
  const out: Record<string, string> = Object.create(null);
  if (!Array.isArray(keys) || keys.length === 0) return out;

  const normalizedKeys = keys
    .map((k) => (typeof k === "string" ? k.trim() : ""))
    .filter((k) => k.length > 0);

  if (normalizedKeys.length === 0) return out;

  const rows = await db
    .select()
    .from(settings)
    .where(and(eq(settings.userId, userId), inArray(settings.key, normalizedKeys)));

  for (const row of rows) {
    out[row.key] = row.key === TOOLS_KEY ? decrypt(row.value) : row.value;
  }
  return out;
}

export async function setSettingValue(userId: string, key: string, value: string) {
  const normalizedKey = key.trim();
  if (!normalizedKey) {
    throw new Error("key is required");
  }

  if (
    normalizedKey === "liveSearch.provider" &&
    !["auto", "tavily", "deepseek", "duckduckgo"].includes(value)
  )
    throw new Error("Invalid search provider");
  if (normalizedKey === "deepseek.nativeWebEnabled" && value !== "true" && value !== "false")
    throw new Error("Invalid native web setting");
  if (normalizedKey === TOOLS_KEY && (!value.trim() || value.length > 4096 || /\s/.test(value)))
    throw new Error("Invalid tools API key");
  const normalizedValue = normalizedKey === TOOLS_KEY ? encrypt(value) : value;
  const now = new Date();

  // Upsert against the (user_id, key) unique index so concurrent writes can't
  // duplicate rows. Requires the settings_user_key_unique index (declared in
  // both packages/db/src/schema/index.ts and apps/server/src/db/bootstrap.ts).
  await db
    .insert(settings)
    .values({
      id: generateId(),
      userId,
      key: normalizedKey,
      value: normalizedValue,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [settings.userId, settings.key],
      set: { value: normalizedValue, updatedAt: now },
    });
}

export async function deleteSettingValue(userId: string, key: string) {
  const normalizedKey = key.trim();
  if (!normalizedKey) return;
  await db
    .delete(settings)
    .where(and(eq(settings.userId, userId), eq(settings.key, normalizedKey)));
}
