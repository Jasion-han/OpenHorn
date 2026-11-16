import { createHash } from "node:crypto";
import { settings } from "db";
import { and, eq, inArray } from "drizzle-orm";
import {
  NATIVE_SEARCH_ACTIVE,
  NATIVE_SEARCH_CONFIG,
  type NativeSearchConnection,
} from "shared/deepseek-native-search";
import {
  DEEPSEEK_ACTIVE_SEARCH_CONNECTION,
  DEEPSEEK_SEARCH_CONNECTION,
} from "shared/deepseek-search";
import {
  OPENROUTER_SEARCH_ACTIVE,
  OPENROUTER_SEARCH_CONFIG,
  type OpenRouterSearchConnection,
} from "shared/openrouter-search";
import {
  normalizeCitations,
  parsePublicWebUrl,
  type ResolveWebHostname,
  readBoundedWebResponse,
  searchDeepSeek,
  searchDeepSeekNative,
  searchOpenRouter,
  selectSearchProvider,
  TAVILY_ACTIVE_SEARCH_CONFIG,
  type WebToolsFetchFn,
} from "shared/search";
import {
  LEGACY_TOOL_KEY,
  TOOL_CONNECTION_SETTING,
  type ToolConnection,
} from "shared/tool-connection";
import type {
  SearchActivationError,
  SearchActivationRequest,
  SearchActivationResult,
  SearchEngine,
  SearchSettingsConfiguration,
  SearchSettingsStatus,
} from "shared/types";
import { db } from "../db";
import { decrypt, encrypt, generateId } from "../utils";
import {
  listNativeSearchChannels,
  nativeSearchFingerprint,
  type ResolvedNativeSearch,
  resolveNativeSearchConnection,
} from "./nativeSearchSettings";
import {
  openRouterSearchFingerprint,
  resolveOpenRouterSearchConnection,
} from "./openRouterSearchSettings";
import { withSearchSettingsTransaction } from "./searchSettingsTransaction";
import { resolveToolConnection, toolConnectionFingerprint } from "./toolConnectionService";

const PROVIDER = "liveSearch.provider";
const TAVILY_KEY = "liveSearch.tavilyApiKey";
const TAVILY_ENABLED = "liveSearch.tavilyEnabled";
export const SEARCH_VERIFICATION_PREFIX = "liveSearch.verification.";
const verificationKey = (provider: SearchEngine) => `${SEARCH_VERIFICATION_PREFIX}${provider}`;
const keys = [
  PROVIDER,
  TAVILY_KEY,
  TAVILY_ENABLED,
  DEEPSEEK_SEARCH_CONNECTION,
  DEEPSEEK_ACTIVE_SEARCH_CONNECTION,
  TOOL_CONNECTION_SETTING,
  LEGACY_TOOL_KEY,
  verificationKey("tavily"),
  verificationKey("deepseek"),
  verificationKey("deepseek-native"),
  verificationKey("openrouter"),
  OPENROUTER_SEARCH_CONFIG,
  OPENROUTER_SEARCH_ACTIVE,
  NATIVE_SEARCH_CONFIG,
  NATIVE_SEARCH_ACTIVE,
  TAVILY_ACTIVE_SEARCH_CONFIG,
];
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
type Snapshot = {
  status: SearchSettingsStatus;
  values: Record<string, string>;
  connection?: ToolConnection;
  activeConnection?: ToolConnection;
  nativeCandidate?: ResolvedNativeSearch;
  nativeActive?: ResolvedNativeSearch;
  openRouterCandidate?: OpenRouterSearchConnection;
  openRouterActive?: OpenRouterSearchConnection;
  tavilyKey: string;
  activeTavilyKey: string;
  activeTavilySource: "user" | "server";
};
type Database = Pick<typeof db, "select">;
type Verification = { fingerprint: string; verifiedAt: string };

function readVerification(raw: string | undefined): Verification | undefined {
  try {
    const value = JSON.parse(raw ?? "null");
    return typeof value?.fingerprint === "string" && typeof value.verifiedAt === "string"
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}

function fingerprint(
  snapshot: Pick<Snapshot, "connection" | "tavilyKey" | "nativeCandidate" | "openRouterCandidate">,
  engine: SearchEngine,
) {
  if (engine === "deepseek-native")
    return nativeSearchFingerprint(snapshot.nativeCandidate?.connection);
  if (engine === "openrouter") return openRouterSearchFingerprint(snapshot.openRouterCandidate);
  return engine === "deepseek"
    ? snapshot.connection && toolConnectionFingerprint(snapshot.connection)
    : engine === "tavily" && snapshot.tavilyKey
      ? hash(`tavily:${snapshot.tavilyKey}`)
      : undefined;
}

async function readSnapshot(userId: string, database: Database = db): Promise<Snapshot> {
  const rows = await database
    .select()
    .from(settings)
    .where(and(eq(settings.userId, userId), inArray(settings.key, keys)));
  rows.sort((a, b) => a.key.localeCompare(b.key));
  const values: Record<string, string> = Object.create(null);
  for (const row of rows) {
    values[row.key] = [
      DEEPSEEK_SEARCH_CONNECTION,
      DEEPSEEK_ACTIVE_SEARCH_CONNECTION,
      TOOL_CONNECTION_SETTING,
      LEGACY_TOOL_KEY,
      TAVILY_ACTIVE_SEARCH_CONFIG,
      NATIVE_SEARCH_CONFIG,
      NATIVE_SEARCH_ACTIVE,
      OPENROUTER_SEARCH_CONFIG,
      OPENROUTER_SEARCH_ACTIVE,
    ].includes(row.key)
      ? decrypt(row.value)
      : row.value;
  }
  const resolved = await resolveToolConnection(
    userId,
    values[DEEPSEEK_SEARCH_CONNECTION] ?? values[TOOL_CONNECTION_SETTING],
    values[LEGACY_TOOL_KEY],
    database,
  );
  const connection = resolved?.kind === "deepseek" ? resolved : undefined;
  const activeResolved =
    values[DEEPSEEK_ACTIVE_SEARCH_CONNECTION] === undefined
      ? connection
      : await resolveToolConnection(
          userId,
          values[DEEPSEEK_ACTIVE_SEARCH_CONNECTION],
          undefined,
          database,
        );
  const verifiedDeepSeek = readVerification(values[verificationKey("deepseek")]);
  const activeConnection =
    activeResolved?.kind === "deepseek" &&
    (!verifiedDeepSeek ||
      verifiedDeepSeek.fingerprint === toolConnectionFingerprint(activeResolved))
      ? activeResolved
      : undefined;
  const nativeCandidate = await resolveNativeSearchConnection(
    userId,
    values[NATIVE_SEARCH_CONFIG],
    database,
  );
  const rawNativeActive = await resolveNativeSearchConnection(
    userId,
    values[NATIVE_SEARCH_ACTIVE],
    database,
  );
  const nativeRecord = readVerification(values[verificationKey("deepseek-native")]);
  const nativeActive =
    nativeRecord &&
    nativeRecord.fingerprint === nativeSearchFingerprint(rawNativeActive?.connection)
      ? rawNativeActive
      : undefined;
  const tavilyKey = values[TAVILY_KEY]?.trim() || process.env.TAVILY_API_KEY?.trim() || "";
  const openRouterCandidate = resolveOpenRouterSearchConnection(values[OPENROUTER_SEARCH_CONFIG]);
  const rawOpenRouterActive = resolveOpenRouterSearchConnection(values[OPENROUTER_SEARCH_ACTIVE]);
  const openRouterRecord = readVerification(values[verificationKey("openrouter")]);
  const openRouterActive =
    openRouterRecord &&
    openRouterRecord.fingerprint === openRouterSearchFingerprint(rawOpenRouterActive)
      ? rawOpenRouterActive
      : undefined;
  let activeTavilyKey = tavilyKey;
  let activeTavilySource: "user" | "server" = values[TAVILY_KEY]?.trim() ? "user" : "server";
  if (values[TAVILY_ACTIVE_SEARCH_CONFIG] !== undefined) {
    try {
      const active = JSON.parse(values[TAVILY_ACTIVE_SEARCH_CONFIG]);
      activeTavilyKey = typeof active.apiKey === "string" ? active.apiKey : "";
      activeTavilySource = active.source === "user" ? "user" : "server";
    } catch {
      activeTavilyKey = "";
    }
  }
  const tavilyEnabled = values[TAVILY_ENABLED]?.trim().toLowerCase() !== "false";
  const rawProvider = values[PROVIDER] ?? "auto";
  const selected = selectSearchProvider({
    searchProvider: rawProvider,
    tavilyApiKey: tavilyEnabled ? activeTavilyKey : undefined,
    deepseekApiKey: activeConnection?.apiKey,
    nativeSearchApiKey: nativeActive?.connection.apiKey,
    openRouterSearchApiKey: openRouterActive?.apiKey,
  });
  const effectiveProvider = selected.provider;
  const recorded = readVerification(values[verificationKey(effectiveProvider as SearchEngine)]);
  const currentFingerprint = fingerprint(
    {
      connection: activeConnection,
      tavilyKey: activeTavilyKey,
      nativeCandidate: nativeActive,
      openRouterCandidate: openRouterActive,
    },
    effectiveProvider as SearchEngine,
  );
  const verified = Boolean(currentFingerprint && recorded?.fingerprint === currentFingerprint);
  return {
    values,
    connection,
    activeConnection,
    nativeCandidate,
    nativeActive,
    openRouterCandidate,
    openRouterActive,
    tavilyKey,
    activeTavilyKey,
    activeTavilySource,
    status: {
      configured: effectiveProvider !== "none",
      selectedProvider: [
        "tavily",
        "deepseek",
        "deepseek-native",
        "openrouter",
        "duckduckgo",
      ].includes(rawProvider)
        ? (rawProvider as SearchEngine)
        : "auto",
      effectiveProvider,
      source: effectiveProvider === "tavily" ? activeTavilySource : effectiveProvider,
      verification:
        effectiveProvider === "none"
          ? "unavailable"
          : effectiveProvider === "duckduckgo"
            ? "not_required"
            : verified
              ? "verified"
              : "unverified",
      ...(rawProvider === "deepseek-native" && nativeActive
        ? { nativeConnection: nativeActive.metadata }
        : {}),
      ...(rawProvider === "openrouter" && openRouterActive
        ? {
            openRouterConnection: {
              model: openRouterActive.model,
              endpoint: openRouterActive.baseUrl,
              engine: openRouterActive.engine,
            },
          }
        : {}),
      ...(verified ? { verifiedAt: recorded?.verifiedAt } : {}),
      configuredProviders: [
        ...(tavilyKey || activeTavilyKey ? ["tavily" as const] : []),
        ...(values[NATIVE_SEARCH_CONFIG] || values[NATIVE_SEARCH_ACTIVE]
          ? ["deepseek-native" as const]
          : []),
        ...(values[OPENROUTER_SEARCH_CONFIG] || values[OPENROUTER_SEARCH_ACTIVE]
          ? ["openrouter" as const]
          : []),
        ...(values[DEEPSEEK_SEARCH_CONNECTION] || activeConnection || connection
          ? ["deepseek" as const]
          : []),
      ],
      availableProviders: [
        ...(activeTavilyKey &&
        readVerification(values[verificationKey("tavily")])?.fingerprint ===
          hash(`tavily:${activeTavilyKey}`)
          ? ["tavily" as const]
          : []),
        ...(nativeActive ? ["deepseek-native" as const] : []),
        ...(openRouterActive ? ["openrouter" as const] : []),
        ...(activeConnection &&
        verifiedDeepSeek?.fingerprint === toolConnectionFingerprint(activeConnection)
          ? ["deepseek" as const]
          : []),
      ],
      pendingProviders: [
        ...(openRouterSearchFingerprint(openRouterCandidate) !==
        openRouterSearchFingerprint(openRouterActive)
          ? ["openrouter" as const]
          : []),
        ...(nativeSearchFingerprint(nativeCandidate?.connection) !==
        nativeSearchFingerprint(nativeActive?.connection)
          ? ["deepseek-native" as const]
          : []),
        ...(fingerprint({ connection, tavilyKey }, "deepseek") !==
        fingerprint({ connection: activeConnection, tavilyKey }, "deepseek")
          ? ["deepseek" as const]
          : []),
        ...(tavilyKey !== activeTavilyKey ? ["tavily" as const] : []),
      ],
      revision: hash(
        JSON.stringify({
          rows: rows.map((row) => [row.key, row.value, row.updatedAt]),
          connection: connection && toolConnectionFingerprint(connection),
          activeConnection: activeConnection && toolConnectionFingerprint(activeConnection),
          tavily: hash(tavilyKey),
          nativeCandidate: nativeSearchFingerprint(nativeCandidate?.connection),
          nativeActive: nativeSearchFingerprint(nativeActive?.connection),
          openRouterCandidate: openRouterSearchFingerprint(openRouterCandidate),
          openRouterActive: openRouterSearchFingerprint(openRouterActive),
        }),
      ),
    },
  };
}

export async function getSearchSettingsStatus(userId: string): Promise<SearchSettingsStatus> {
  return (await readSnapshot(userId)).status;
}

/** The displayed candidates and activation revision must come from one database snapshot. */
export async function getSearchSettingsConfiguration(
  userId: string,
): Promise<SearchSettingsConfiguration> {
  return withSearchSettingsTransaction(async (tx) => {
    const snapshot = await readSnapshot(userId, tx);
    const visible: Record<string, string> = Object.create(null);
    for (const key of [
      DEEPSEEK_SEARCH_CONNECTION,
      TOOL_CONNECTION_SETTING,
      LEGACY_TOOL_KEY,
      TAVILY_KEY,
      NATIVE_SEARCH_CONFIG,
      OPENROUTER_SEARCH_CONFIG,
    ]) {
      if (snapshot.values[key] !== undefined) visible[key] = snapshot.values[key];
    }
    return {
      settings: visible,
      status: snapshot.status,
      nativeChannels: await listNativeSearchChannels(userId, tx),
      nativeSearchAvailable: true,
      openRouterSearchAvailable: true,
    };
  });
}

export async function getActiveDeepSeekSearchConnection(
  userId: string,
): Promise<ToolConnection | undefined> {
  const snapshot = await readSnapshot(userId);
  return snapshot.values[PROVIDER] === "deepseek" ? snapshot.activeConnection : undefined;
}

export async function getActiveNativeSearchConnection(
  userId: string,
): Promise<NativeSearchConnection | undefined> {
  const snapshot = await readSnapshot(userId);
  return snapshot.values[PROVIDER] === "deepseek-native"
    ? snapshot.nativeActive?.connection
    : undefined;
}

export async function getActiveOpenRouterSearchConnection(
  userId: string,
): Promise<OpenRouterSearchConnection | undefined> {
  const snapshot = await readSnapshot(userId);
  return snapshot.values[PROVIDER] === "openrouter" ? snapshot.openRouterActive : undefined;
}

/** Legacy settings reads remain compatible; new writes may not enable an unverified paid route. */
export async function assertSearchSelectionWrite(
  userId: string,
  key: string,
  value: string | null,
  database: Database = db,
): Promise<void> {
  const snapshot = await readSnapshot(userId, database);
  const selected = key === PROVIDER ? (value ?? "auto") : (snapshot.values[PROVIDER] ?? "auto");
  const enabled =
    key === TAVILY_ENABLED
      ? value !== "false"
      : snapshot.values[TAVILY_ENABLED]?.trim().toLowerCase() !== "false";
  const tavily = selectSearchProvider({
    searchProvider: selected,
    tavilyApiKey: enabled ? snapshot.activeTavilyKey : undefined,
    deepseekApiKey: snapshot.activeConnection?.apiKey,
    nativeSearchApiKey: snapshot.nativeActive?.connection.apiKey,
    openRouterSearchApiKey: snapshot.openRouterActive?.apiKey,
  });
  if (tavily.provider === "tavily") {
    const recorded = readVerification(snapshot.values[verificationKey("tavily")]);
    if (!recorded || recorded.fingerprint !== hash(`tavily:${snapshot.activeTavilyKey}`))
      throw new Error("search_verification_required");
  }
}

/** Selection and legacy-switch writes validate and mutate one serializable snapshot. */
export async function writeSearchSelection(
  userId: string,
  key: "liveSearch.provider" | "liveSearch.tavilyEnabled",
  value: string | null,
): Promise<void> {
  await withSearchSettingsTransaction(async (tx) => {
    await assertSearchSelectionWrite(userId, key, value, tx);
    if (
      key === PROVIDER &&
      value === "deepseek" &&
      !(await hasVerifiedDeepSeekConnection(userId, tx))
    )
      throw new Error("search_verification_required");
    if (
      key === PROVIDER &&
      value === "deepseek-native" &&
      !(await readSnapshot(userId, tx)).nativeActive
    )
      throw new Error("search_verification_required");
    if (
      key === PROVIDER &&
      value === "openrouter" &&
      !(await readSnapshot(userId, tx)).openRouterActive
    )
      throw new Error("search_verification_required");
    if (value === null) {
      await tx.delete(settings).where(and(eq(settings.userId, userId), eq(settings.key, key)));
    } else {
      const now = new Date();
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

export async function getTavilySearchRuntimeKey(userId: string): Promise<string> {
  const snapshot = await readSnapshot(userId);
  return snapshot.values[TAVILY_ENABLED]?.trim().toLowerCase() === "false"
    ? ""
    : snapshot.activeTavilyKey;
}

/** Keep the working credential while saving an unverified replacement. */
export async function saveTavilySearchKey(userId: string, value: string | null): Promise<void> {
  if (value !== null && (value.length > 4096 || /\s/.test(value)))
    throw new Error("invalid_search_key");
  await withSearchSettingsTransaction(async (tx) => {
    const before = await readSnapshot(userId, tx);
    const now = new Date();
    if (before.values[TAVILY_ACTIVE_SEARCH_CONFIG] === undefined) {
      await tx.insert(settings).values({
        id: generateId(),
        userId,
        key: TAVILY_ACTIVE_SEARCH_CONFIG,
        value: encrypt(
          JSON.stringify({ apiKey: before.activeTavilyKey, source: before.activeTavilySource }),
        ),
        updatedAt: now,
      });
    }
    if (!value) {
      await tx
        .delete(settings)
        .where(and(eq(settings.userId, userId), eq(settings.key, TAVILY_KEY)));
    } else {
      await tx
        .insert(settings)
        .values({ id: generateId(), userId, key: TAVILY_KEY, value, updatedAt: now })
        .onConflictDoUpdate({
          target: [settings.userId, settings.key],
          set: { value, updatedAt: now },
        });
    }
  });
}

export async function hasVerifiedDeepSeekConnection(
  userId: string,
  database: Database = db,
): Promise<boolean> {
  const snapshot = await readSnapshot(userId, database);
  const record = readVerification(snapshot.values[verificationKey("deepseek")]);
  return Boolean(
    record &&
      record.fingerprint ===
        fingerprint({ ...snapshot, connection: snapshot.activeConnection }, "deepseek"),
  );
}

function verificationError(error: unknown): SearchActivationError {
  const message = error instanceof Error ? error.message : "";
  if (message === "HTTP 401" || message === "HTTP 403") return "search_auth_failed";
  if (message === "HTTP 404" || message === "HTTP 405") return "search_endpoint_unsupported";
  if (message === "HTTP 429") return "search_rate_limited";
  if (message === "timeout" || (error instanceof Error && error.name === "TimeoutError"))
    return "search_timeout";
  if (["invalid_response", "response_too_large"].includes(message))
    return "search_invalid_response";
  if (message === "native_search_not_executed") return "search_not_executed";
  if (message === "no_sources") return "search_no_results";
  if (message === "no_results") return "search_no_results";
  return "search_request_failed";
}

type ProbeOptions = {
  fetchImpl?: WebToolsFetchFn;
  resolveHostname?: ResolveWebHostname;
  timeoutMs?: number;
  /** Explicit validation may accept a connection without switching the selected provider. */
  activate?: boolean;
};
const verifying = new Set<string>();

/** Only an explicit user action probes upstream. Failures never change the active engine. */
export async function verifyAndActivateSearch(
  userId: string,
  input: SearchActivationRequest,
  options: ProbeOptions = {},
): Promise<SearchActivationResult> {
  if (verifying.has(userId))
    return { success: false, errorCode: "search_verification_in_progress" };
  verifying.add(userId);
  try {
    const before = await withSearchSettingsTransaction((tx) => readSnapshot(userId, tx));
    if (before.status.revision !== input.revision)
      return { success: false, errorCode: "search_configuration_changed" };
    const currentFingerprint = fingerprint(before, input.provider);
    if (input.provider !== "duckduckgo" && !currentFingerprint)
      return { success: false, errorCode: "search_not_configured" };
    try {
      if (input.provider === "openrouter" && before.openRouterCandidate) {
        await searchOpenRouter("DeepSeek Responses API web_search documentation", {
          ...options,
          connection: before.openRouterCandidate,
          timeoutMs: options.timeoutMs ?? 45_000,
        });
      } else if (input.provider === "deepseek-native" && before.nativeCandidate) {
        await searchDeepSeekNative("DeepSeek official API documentation", {
          ...options,
          connection: before.nativeCandidate.connection,
          timeoutMs: options.timeoutMs ?? 45_000,
        });
      } else if (input.provider === "deepseek" && before.connection) {
        const sources = await searchDeepSeek("DeepSeek API documentation", {
          ...options,
          apiKey: before.connection.apiKey,
          baseUrl: before.connection.baseUrl,
          maxResults: 1,
          timeoutMs: options.timeoutMs ?? 8_000,
        });
        if (!sources.length) throw new Error("no_results");
      } else if (input.provider === "tavily") {
        const signal = AbortSignal.timeout(options.timeoutMs ?? 8_000);
        const response = await (options.fetchImpl ?? fetch)("https://api.tavily.com/search", {
          method: "POST",
          redirect: "error",
          signal,
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${before.tavilyKey}`,
          },
          body: JSON.stringify({
            query: "Tavily API documentation",
            max_results: 1,
            search_depth: "basic",
          }),
        });
        if (!response.ok) {
          void response.body?.cancel().catch(() => {});
          throw new Error(`HTTP ${response.status}`);
        }
        let payload: unknown;
        try {
          payload = JSON.parse(await readBoundedWebResponse(response, undefined, signal));
        } catch (error) {
          if (signal.aborted) throw new Error("timeout");
          throw error instanceof SyntaxError ? new Error("invalid_response") : error;
        }
        if (
          !payload ||
          typeof payload !== "object" ||
          !("results" in payload) ||
          !Array.isArray(payload.results) ||
          "error" in payload
        )
          throw new Error("invalid_response");
        if (
          payload.results.some(
            (item) =>
              !item ||
              typeof item !== "object" ||
              typeof item.url !== "string" ||
              (item.title != null && typeof item.title !== "string") ||
              (item.content != null && typeof item.content !== "string"),
          )
        )
          throw new Error("invalid_response");
        const sources = normalizeCitations(payload.results).filter((item) => {
          try {
            parsePublicWebUrl(item.url);
            return true;
          } catch {
            return false;
          }
        });
        if (!sources.length) throw new Error("no_results");
      }
    } catch (error) {
      return { success: false, errorCode: verificationError(error) };
    }
    const activated = await withSearchSettingsTransaction(async (tx) => {
      const current = await readSnapshot(userId, tx);
      if (current.status.revision !== before.status.revision) return false;
      const now = new Date();
      const updates: [string, string][] =
        options.activate === false ? [] : [[PROVIDER, input.provider]];
      if (input.provider === "deepseek-native")
        updates.push([NATIVE_SEARCH_ACTIVE, encrypt(before.values[NATIVE_SEARCH_CONFIG])]);
      if (input.provider === "openrouter")
        updates.push([OPENROUTER_SEARCH_ACTIVE, encrypt(before.values[OPENROUTER_SEARCH_CONFIG])]);
      if (input.provider === "deepseek") {
        const config =
          before.values[DEEPSEEK_SEARCH_CONNECTION] ??
          before.values[TOOL_CONNECTION_SETTING] ??
          JSON.stringify({ ...before.connection, source: "manual" });
        updates.push([DEEPSEEK_ACTIVE_SEARCH_CONNECTION, encrypt(config)]);
      }
      if (input.provider === "tavily") {
        if (options.activate !== false) updates.push([TAVILY_ENABLED, "true"]);
        updates.push([
          TAVILY_ACTIVE_SEARCH_CONFIG,
          encrypt(
            JSON.stringify({
              apiKey: before.tavilyKey,
              source: before.values[TAVILY_KEY]?.trim() ? "user" : "server",
            }),
          ),
        ]);
      }
      if (currentFingerprint)
        updates.push([
          verificationKey(input.provider),
          JSON.stringify({ fingerprint: currentFingerprint, verifiedAt: now.toISOString() }),
        ]);
      for (const [key, value] of updates) {
        await tx
          .insert(settings)
          .values({ id: generateId(), userId, key, value, updatedAt: now })
          .onConflictDoUpdate({
            target: [settings.userId, settings.key],
            set: { value, updatedAt: now },
          });
      }
      return true;
    });
    return activated
      ? { success: true, status: await getSearchSettingsStatus(userId) }
      : { success: false, errorCode: "search_configuration_changed" };
  } finally {
    verifying.delete(userId);
  }
}
