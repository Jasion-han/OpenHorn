import { settings } from "db";
import { and, eq, inArray } from "drizzle-orm";
import {
  DEEPSEEK_ACTIVE_SEARCH_CONNECTION,
  DEEPSEEK_SEARCH_CONNECTION,
  parseDeepSeekSearchConfig,
} from "shared/deepseek-search";
import { LEGACY_TOOL_KEY, TOOL_CONNECTION_SETTING } from "shared/tool-connection";
import { decrypt, encrypt, generateId } from "../utils";
import {
  type SearchSettingsTransaction,
  withSearchSettingsTransaction,
} from "./searchSettingsTransaction";
import { resolveToolConnection } from "./toolConnectionService";

/** Freeze the old route (including an unavailable sentinel) before changing legacy credentials. */
async function preserveActiveConnection(userId: string, tx: SearchSettingsTransaction) {
  const rows = await tx
    .select()
    .from(settings)
    .where(
      and(
        eq(settings.userId, userId),
        inArray(settings.key, [
          "liveSearch.provider",
          DEEPSEEK_ACTIVE_SEARCH_CONNECTION,
          DEEPSEEK_SEARCH_CONNECTION,
          TOOL_CONNECTION_SETTING,
          LEGACY_TOOL_KEY,
        ]),
      ),
    );
  const existing = new Map(rows.map((row) => [row.key, row.value]));
  if (
    existing.get("liveSearch.provider") !== "deepseek" ||
    existing.has(DEEPSEEK_ACTIVE_SEARCH_CONNECTION)
  )
    return;
  const previous =
    existing.get(DEEPSEEK_SEARCH_CONNECTION) ?? existing.get(TOOL_CONNECTION_SETTING);
  const legacy = existing.get(LEGACY_TOOL_KEY);
  const old = await resolveToolConnection(
    userId,
    previous ? decrypt(previous) : undefined,
    legacy ? decrypt(legacy) : undefined,
    tx,
  );
  const active =
    old?.kind === "deepseek"
      ? previous
        ? decrypt(previous)
        : JSON.stringify({ ...old, source: "manual" })
      : "null";
  await tx.insert(settings).values({
    id: generateId(),
    userId,
    key: DEEPSEEK_ACTIVE_SEARCH_CONNECTION,
    value: encrypt(active),
    updatedAt: new Date(),
  });
}

/** Saving a credential route does not assert capability or change the selected engine. */
export async function saveDeepSeekSearchConnection(userId: string, raw: string): Promise<void> {
  const config = parseDeepSeekSearchConfig(raw);
  await withSearchSettingsTransaction(async (tx) => {
    const connection = await resolveToolConnection(userId, JSON.stringify(config), undefined, tx);
    if (!connection || connection.kind !== "deepseek")
      throw new Error("deepseek_search_connection_unavailable");
    await preserveActiveConnection(userId, tx);
    const value = encrypt(JSON.stringify(config)),
      now = new Date();
    await tx
      .insert(settings)
      .values({ id: generateId(), userId, key: DEEPSEEK_SEARCH_CONNECTION, value, updatedAt: now })
      .onConflictDoUpdate({
        target: [settings.userId, settings.key],
        set: { value, updatedAt: now },
      });
  });
}

/** Legacy credential writes and dedicated candidate deletion preserve the current search route. */
export async function writeToolSettingPreservingSearch(
  userId: string,
  key: string,
  raw: string | null,
): Promise<void> {
  await withSearchSettingsTransaction(async (tx) => {
    await preserveActiveConnection(userId, tx);
    if (raw === null) {
      await tx.delete(settings).where(and(eq(settings.userId, userId), eq(settings.key, key)));
    } else {
      const value = encrypt(raw),
        now = new Date();
      await tx
        .insert(settings)
        .values({ id: generateId(), userId, key, value, updatedAt: now })
        .onConflictDoUpdate({
          target: [settings.userId, settings.key],
          set: { value, updatedAt: now },
        });
    }
  });
}
