import { settings } from "db";
import { and, eq } from "drizzle-orm";
import { JEV_FEATURES, JEV_MODEL } from "shared/decisions";
import type { JevFeature, JevPreferences, JevStatus } from "shared/types";
import { db } from "../db";
import { generateId } from "../utils";
import { getSettingValues, setSettingValue } from "./settingsService";

const PREFS = "decision.jev.preferences";
const USAGE = "decision.jev.usage";
// Reserve the complete documented default request ceiling. Unknown billing keeps its reservation.
export const JEV_REQUEST_RESERVE_USD = 65_536 * 0.000000042;
interface Ledger {
  day: string;
  spentUsd: number;
  reserved: Record<string, number>;
  requests: number;
}
const dayNow = () => new Date().toISOString().slice(0, 10);
export function getJevApiKey(): string | undefined {
  if (process.env.NODE_ENV === "test" && process.env.OPENHORN_JEV_SYNTHETIC !== "1")
    return undefined;
  return process.env.OPENHORN_JEV_API_KEY?.trim() || undefined;
}
export function jevDailyLimit(): number {
  const value = Number(process.env.OPENHORN_JEV_DAILY_BUDGET_USD ?? "0.05");
  return Number.isFinite(value) && value >= 0 && value <= 10 ? value : 0;
}
function ledger(raw: string | undefined, day = dayNow()): Ledger {
  if (!raw) return { day, spentUsd: 0, reserved: {}, requests: 0 };
  const parsed = JSON.parse(raw) as Ledger;
  if (
    typeof parsed.day !== "string" ||
    typeof parsed.spentUsd !== "number" ||
    !Number.isFinite(parsed.spentUsd) ||
    parsed.spentUsd < 0 ||
    !Number.isSafeInteger(parsed.requests) ||
    parsed.requests < 0 ||
    !parsed.reserved ||
    typeof parsed.reserved !== "object" ||
    Array.isArray(parsed.reserved) ||
    Object.values(parsed.reserved).some(
      (n) => typeof n !== "number" || !Number.isFinite(n) || n < 0,
    )
  )
    throw new Error("Invalid decision usage ledger");
  return parsed.day === day ? parsed : { day, spentUsd: 0, reserved: {}, requests: 0 };
}
export async function getJevPreferences(userId: string): Promise<JevPreferences> {
  const raw = (await getSettingValues(userId, [PREFS]))[PREFS];
  let value: Partial<JevPreferences> = {};
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (
        !parsed ||
        typeof parsed !== "object" ||
        Array.isArray(parsed) ||
        typeof parsed.enabled !== "boolean" ||
        !parsed.features ||
        JEV_FEATURES.some((feature) => typeof parsed.features[feature] !== "boolean")
      )
        throw new Error("Invalid decision preferences");
      value = parsed;
    } catch {
      return {
        enabled: false,
        features: Object.fromEntries(JEV_FEATURES.map((feature) => [feature, false])) as Record<
          JevFeature,
          boolean
        >,
      };
    }
  }
  return {
    enabled:
      typeof value?.enabled === "boolean"
        ? value.enabled
        : process.env.OPENHORN_JEV_ENABLED === "true",
    features: Object.fromEntries(
      JEV_FEATURES.map((feature) => [
        feature,
        typeof value?.features?.[feature] === "boolean" ? value.features[feature] : true,
      ]),
    ) as Record<JevFeature, boolean>,
  };
}
export async function saveJevPreferences(userId: string, value: unknown): Promise<void> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid decision preferences");
  const input = value as JevPreferences;
  if (
    typeof input.enabled !== "boolean" ||
    !input.features ||
    JEV_FEATURES.some((key) => typeof input.features[key] !== "boolean")
  )
    throw new Error("Invalid decision preferences");
  await setSettingValue(
    userId,
    PREFS,
    JSON.stringify({
      enabled: input.enabled,
      features: Object.fromEntries(
        JEV_FEATURES.map((feature) => [feature, input.features[feature]]),
      ),
    }),
  );
}
export async function getJevStatus(userId: string): Promise<JevStatus> {
  const preferences = await getJevPreferences(userId);
  const raw = (await getSettingValues(userId, [USAGE]))[USAGE];
  const usage = ledger(raw);
  return {
    ...preferences,
    configured: Boolean(getJevApiKey()),
    model: JEV_MODEL,
    day: usage.day,
    dailyLimitUsd: jevDailyLimit(),
    spentUsd: usage.spentUsd,
    reservedUsd: Object.values(usage.reserved).reduce((sum, n) => sum + n, 0),
    requests: usage.requests,
  };
}
async function mutateLedger<T>(userId: string, change: (value: Ledger) => T): Promise<T> {
  return db.transaction(async (tx) => {
    const row = (
      await tx
        .select()
        .from(settings)
        .where(and(eq(settings.userId, userId), eq(settings.key, USAGE)))
        .limit(1)
    )[0];
    const value = ledger(row?.value);
    const result = change(value);
    const now = new Date();
    await tx
      .insert(settings)
      .values({
        id: generateId(),
        userId,
        key: USAGE,
        value: JSON.stringify(value),
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [settings.userId, settings.key],
        set: { value: JSON.stringify(value), updatedAt: now },
      });
    return result;
  });
}
export async function reserveJevRequest(
  userId: string,
): Promise<{ id: string; day: string } | null> {
  return mutateLedger(userId, (usage) => {
    const total = usage.spentUsd + Object.values(usage.reserved).reduce((sum, n) => sum + n, 0);
    if (total + JEV_REQUEST_RESERVE_USD > jevDailyLimit()) return null;
    const id = generateId();
    usage.reserved[id] = JEV_REQUEST_RESERVE_USD;
    usage.requests++;
    return { id, day: usage.day };
  });
}
export async function settleJevRequest(
  userId: string,
  reservation: { id: string; day: string },
  costUsd: number,
): Promise<void> {
  await mutateLedger(userId, (usage) => {
    if (usage.day !== reservation.day || !Object.hasOwn(usage.reserved, reservation.id)) return;
    if (!Number.isFinite(costUsd) || costUsd < 0 || costUsd > 10) return;
    delete usage.reserved[reservation.id];
    usage.spentUsd += costUsd;
  });
}
