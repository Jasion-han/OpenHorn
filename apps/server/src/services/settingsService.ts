import { settings } from "db";
import { and, eq, inArray } from "drizzle-orm";
import {
  NATIVE_SEARCH_ACTIVE,
  NATIVE_SEARCH_CONFIG,
  NATIVE_SEARCH_RUNTIME,
} from "shared/deepseek-native-search";
import {
  DEEPSEEK_ACTIVE_SEARCH_CONNECTION,
  DEEPSEEK_SEARCH_CONNECTION,
  DEEPSEEK_SEARCH_RUNTIME,
} from "shared/deepseek-search";
import {
  OPENROUTER_SEARCH_ACTIVE,
  OPENROUTER_SEARCH_CONFIG,
  OPENROUTER_SEARCH_RUNTIME,
} from "shared/openrouter-search";
import { TAVILY_ACTIVE_SEARCH_CONFIG, TAVILY_SEARCH_RUNTIME_KEY } from "shared/search";
import {
  LEGACY_TOOL_KEY,
  parseToolConnectionConfig,
  TOOL_CONNECTION_SETTING,
  TOOL_RUNTIME_SETTING,
} from "shared/tool-connection";
import { db } from "../db";
import { decrypt, generateId } from "../utils";
import {
  saveDeepSeekSearchConnection,
  writeToolSettingPreservingSearch,
} from "./deepseekSearchSettings";
import { saveNativeSearchConfig } from "./nativeSearchSettings";
import { saveOpenRouterSearchConfig } from "./openRouterSearchSettings";
import {
  getActiveDeepSeekSearchConnection,
  getActiveNativeSearchConnection,
  getActiveOpenRouterSearchConnection,
  getTavilySearchRuntimeKey,
  SEARCH_VERIFICATION_PREFIX,
  saveTavilySearchKey,
  writeSearchSelection,
} from "./searchSettingsService";
import { resolveToolConnection } from "./toolConnectionService";

const TOOLS_KEY = "deepseek.toolsApiKey";

export async function getSettingValues(userId: string, keys: string[]) {
  const out: Record<string, string> = Object.create(null);
  if (!Array.isArray(keys) || keys.length === 0) return out;

  const normalizedKeys = keys
    .map((k) => (typeof k === "string" ? k.trim() : ""))
    .filter((k) => k.length > 0);

  if (normalizedKeys.length === 0) return out;

  const requested = new Set(normalizedKeys);
  const lookupKeys =
    requested.has(TOOL_RUNTIME_SETTING) || requested.has(DEEPSEEK_SEARCH_RUNTIME)
      ? [
          ...new Set([
            ...normalizedKeys,
            TOOL_CONNECTION_SETTING,
            LEGACY_TOOL_KEY,
            DEEPSEEK_SEARCH_CONNECTION,
            DEEPSEEK_ACTIVE_SEARCH_CONNECTION,
          ]),
        ]
      : normalizedKeys;
  const rows = await db
    .select()
    .from(settings)
    .where(and(eq(settings.userId, userId), inArray(settings.key, lookupKeys)));

  for (const row of rows) {
    out[row.key] =
      row.key === TOOLS_KEY ||
      row.key === TOOL_CONNECTION_SETTING ||
      row.key === DEEPSEEK_SEARCH_CONNECTION ||
      row.key === DEEPSEEK_ACTIVE_SEARCH_CONNECTION ||
      row.key === NATIVE_SEARCH_CONFIG ||
      row.key === NATIVE_SEARCH_ACTIVE ||
      row.key === OPENROUTER_SEARCH_CONFIG ||
      row.key === OPENROUTER_SEARCH_ACTIVE ||
      row.key === TAVILY_ACTIVE_SEARCH_CONFIG
        ? decrypt(row.value)
        : row.value;
  }
  if (requested.has(TOOL_RUNTIME_SETTING)) {
    const connection = await resolveToolConnection(
      userId,
      out[TOOL_CONNECTION_SETTING] === undefined && !out[LEGACY_TOOL_KEY]
        ? out[DEEPSEEK_SEARCH_CONNECTION]
        : out[TOOL_CONNECTION_SETTING],
      out[LEGACY_TOOL_KEY],
    );
    out[TOOL_RUNTIME_SETTING] = connection ? JSON.stringify(connection) : "";
  }
  if (requested.has(DEEPSEEK_SEARCH_RUNTIME)) {
    const connection = await getActiveDeepSeekSearchConnection(userId);
    out[DEEPSEEK_SEARCH_RUNTIME] =
      connection?.kind === "deepseek" ? JSON.stringify(connection) : "";
  }
  if (requested.has(TAVILY_SEARCH_RUNTIME_KEY))
    out[TAVILY_SEARCH_RUNTIME_KEY] = await getTavilySearchRuntimeKey(userId);
  if (requested.has(NATIVE_SEARCH_RUNTIME)) {
    const native = await getActiveNativeSearchConnection(userId);
    out[NATIVE_SEARCH_RUNTIME] = native ? JSON.stringify(native) : "";
  }
  if (requested.has(OPENROUTER_SEARCH_RUNTIME)) {
    const connection = await getActiveOpenRouterSearchConnection(userId);
    out[OPENROUTER_SEARCH_RUNTIME] = connection ? JSON.stringify(connection) : "";
  }
  for (const key of lookupKeys) if (!requested.has(key)) delete out[key];
  return out;
}

export async function setSettingValue(userId: string, key: string, value: string) {
  const normalizedKey = key.trim();
  if (!normalizedKey) {
    throw new Error("key is required");
  }
  if (
    normalizedKey === NATIVE_SEARCH_ACTIVE ||
    normalizedKey === OPENROUTER_SEARCH_ACTIVE ||
    normalizedKey === OPENROUTER_SEARCH_RUNTIME ||
    normalizedKey === NATIVE_SEARCH_RUNTIME ||
    normalizedKey === TOOL_RUNTIME_SETTING ||
    normalizedKey === DEEPSEEK_SEARCH_RUNTIME ||
    normalizedKey === DEEPSEEK_ACTIVE_SEARCH_CONNECTION ||
    normalizedKey === TAVILY_ACTIVE_SEARCH_CONFIG ||
    normalizedKey === TAVILY_SEARCH_RUNTIME_KEY ||
    normalizedKey.startsWith(SEARCH_VERIFICATION_PREFIX)
  )
    throw new Error("read_only_setting");
  if (normalizedKey === NATIVE_SEARCH_CONFIG) return saveNativeSearchConfig(userId, value);
  if (normalizedKey === OPENROUTER_SEARCH_CONFIG) return saveOpenRouterSearchConfig(userId, value);
  if (normalizedKey === DEEPSEEK_SEARCH_CONNECTION)
    return saveDeepSeekSearchConnection(userId, value);
  if (normalizedKey === "liveSearch.tavilyApiKey") return saveTavilySearchKey(userId, value.trim());
  if (normalizedKey === TOOL_CONNECTION_SETTING)
    value = JSON.stringify(parseToolConnectionConfig(value));

  if (
    normalizedKey === "liveSearch.provider" &&
    !["auto", "tavily", "deepseek", "deepseek-native", "openrouter", "duckduckgo"].includes(value)
  )
    throw new Error("Invalid search provider");
  if (normalizedKey === "liveSearch.tavilyEnabled" && value !== "true" && value !== "false")
    throw new Error("Invalid Tavily setting");
  if (normalizedKey === "liveSearch.provider" || normalizedKey === "liveSearch.tavilyEnabled")
    return writeSearchSelection(userId, normalizedKey, value);
  if (normalizedKey === "deepseek.nativeWebEnabled")
    throw new Error("deprecated_native_web_setting");
  if (normalizedKey === TOOLS_KEY && (!value.trim() || value.length > 4096 || /\s/.test(value)))
    throw new Error("Invalid tools API key");
  if (normalizedKey === TOOLS_KEY || normalizedKey === TOOL_CONNECTION_SETTING)
    return writeToolSettingPreservingSearch(userId, normalizedKey, value);
  const normalizedValue = value;
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
  if (
    normalizedKey === NATIVE_SEARCH_ACTIVE ||
    normalizedKey === OPENROUTER_SEARCH_ACTIVE ||
    normalizedKey === OPENROUTER_SEARCH_RUNTIME ||
    normalizedKey === NATIVE_SEARCH_RUNTIME ||
    normalizedKey === TOOL_RUNTIME_SETTING ||
    normalizedKey === DEEPSEEK_SEARCH_RUNTIME ||
    normalizedKey === DEEPSEEK_ACTIVE_SEARCH_CONNECTION ||
    normalizedKey === TAVILY_ACTIVE_SEARCH_CONFIG ||
    normalizedKey === TAVILY_SEARCH_RUNTIME_KEY ||
    normalizedKey.startsWith(SEARCH_VERIFICATION_PREFIX)
  )
    throw new Error("read_only_setting");
  if (!normalizedKey) return;
  if (normalizedKey === NATIVE_SEARCH_CONFIG) return saveNativeSearchConfig(userId, null);
  if (normalizedKey === OPENROUTER_SEARCH_CONFIG) return saveOpenRouterSearchConfig(userId, null);
  if (normalizedKey === "liveSearch.provider" || normalizedKey === "liveSearch.tavilyEnabled")
    return writeSearchSelection(userId, normalizedKey, null);
  if (normalizedKey === "liveSearch.tavilyApiKey") return saveTavilySearchKey(userId, null);
  if (
    normalizedKey === TOOLS_KEY ||
    normalizedKey === TOOL_CONNECTION_SETTING ||
    normalizedKey === DEEPSEEK_SEARCH_CONNECTION
  )
    return writeToolSettingPreservingSearch(userId, normalizedKey, null);
  await db
    .delete(settings)
    .where(and(eq(settings.userId, userId), eq(settings.key, normalizedKey)));
}
