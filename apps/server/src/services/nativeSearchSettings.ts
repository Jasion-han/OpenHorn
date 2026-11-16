import { createHash } from "node:crypto";
import { channelModels, channels, settings } from "db";
import { and, eq } from "drizzle-orm";
import {
  isNativeSearchEndpoint,
  NATIVE_SEARCH_BASE_URL,
  NATIVE_SEARCH_CONFIG,
  NATIVE_SEARCH_MODEL,
  type NativeSearchChannelOption,
  type NativeSearchConnection,
  parseNativeSearchConfig,
} from "shared/deepseek-native-search";
import { db } from "../db";
import { decrypt, encrypt, generateId } from "../utils";
import { withSearchSettingsTransaction } from "./searchSettingsTransaction";

type Database = Pick<typeof db, "select">;
export type ResolvedNativeSearch = {
  connection: NativeSearchConnection;
  metadata: { source: "manual" | "channel"; channelName?: string; model: string; endpoint: string };
};
export const nativeSearchFingerprint = (connection: NativeSearchConnection | undefined) =>
  connection
    ? createHash("sha256")
        .update(JSON.stringify({ provider: "deepseek-native", ...connection }))
        .digest("hex")
    : undefined;

export async function resolveNativeSearchConnection(
  userId: string,
  raw: string | undefined,
  database: Database = db,
): Promise<ResolvedNativeSearch | undefined> {
  try {
    if (raw === undefined) return undefined;
    const config = parseNativeSearchConfig(raw);
    let apiKey: string, name: string | undefined;
    if (config.source === "channel") {
      const [row] = await database
        .select()
        .from(channels)
        .where(and(eq(channels.id, config.channelId), eq(channels.userId, userId)));
      if (
        !row ||
        !row.enabled ||
        row.protocol !== "openai" ||
        !row.apiKey ||
        !isNativeSearchEndpoint(row.baseUrl ?? "")
      )
        return undefined;
      const [model] = await database
        .select()
        .from(channelModels)
        .where(
          and(
            eq(channelModels.channelId, row.id),
            eq(channelModels.modelId, NATIVE_SEARCH_MODEL),
            eq(channelModels.enabled, true),
          ),
        )
        .limit(1);
      if (!model) return undefined;
      apiKey = decrypt(row.apiKey);
      name = row.name;
    } else apiKey = config.apiKey;
    if (!apiKey.trim() || apiKey.startsWith("__cli_oauth__:") || /\s/.test(apiKey))
      return undefined;
    return {
      connection: { apiKey, baseUrl: NATIVE_SEARCH_BASE_URL, model: NATIVE_SEARCH_MODEL },
      metadata: {
        source: config.source,
        ...(name ? { channelName: name } : {}),
        model: NATIVE_SEARCH_MODEL,
        endpoint: NATIVE_SEARCH_BASE_URL,
      },
    };
  } catch {
    return undefined;
  }
}

export async function listNativeSearchChannels(
  userId: string,
  database: Database,
): Promise<NativeSearchChannelOption[]> {
  const rows = await database
    .select({ id: channels.id, name: channels.name })
    .from(channels)
    .innerJoin(channelModels, eq(channelModels.channelId, channels.id))
    .where(
      and(
        eq(channels.userId, userId),
        eq(channels.enabled, true),
        eq(channels.protocol, "openai"),
        eq(channelModels.modelId, NATIVE_SEARCH_MODEL),
        eq(channelModels.enabled, true),
      ),
    );
  const options: NativeSearchChannelOption[] = [];
  for (const row of rows) {
    if (options.some((option) => option.channelId === row.id)) continue;
    if (
      await resolveNativeSearchConnection(
        userId,
        JSON.stringify({ source: "channel", channelId: row.id }),
        database,
      )
    )
      options.push({ channelId: row.id, name: row.name, model: NATIVE_SEARCH_MODEL });
  }
  return options;
}

export async function saveNativeSearchConfig(userId: string, raw: string | null): Promise<void> {
  const config = raw === null ? null : parseNativeSearchConfig(raw);
  await withSearchSettingsTransaction(async (tx) => {
    if (config === null) {
      await tx
        .delete(settings)
        .where(and(eq(settings.userId, userId), eq(settings.key, NATIVE_SEARCH_CONFIG)));
      return;
    }
    if (!(await resolveNativeSearchConnection(userId, JSON.stringify(config), tx)))
      throw new Error("native_search_connection_unavailable");
    const value = encrypt(JSON.stringify(config)),
      now = new Date();
    await tx
      .insert(settings)
      .values({ id: generateId(), userId, key: NATIVE_SEARCH_CONFIG, value, updatedAt: now })
      .onConflictDoUpdate({
        target: [settings.userId, settings.key],
        set: { value, updatedAt: now },
      });
  });
}
