import { normalizeModelContextMetadata } from "shared/context-policy";
import type { ModelContextMetadata } from "shared/types";
import { fetchModelMetadata } from "./metadataFetch";

export const CONTEXT_METADATA_TTL_MS = 24 * 60 * 60_000;
const FAILURE_BACKOFF_MS = 60_000;
const FETCH_TIMEOUT_MS = 12_000;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_MODELS = 20_000;
const MAX_PAGES = 20;
const CATALOG_URL = "https://models.dev/models.json";

type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordValue)
    : null;
}
function smallest(...values: unknown[]): number | undefined {
  const valid = values.filter(
    (value): value is number =>
      typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 16_777_216,
  );
  return valid.length ? Math.min(...valid) : undefined;
}

type DirectoryLimits = {
  contextWindow?: number;
  maxInputTokens?: number;
  maxOutputTokens?: number;
};

function parseDirectoryLimits(value: unknown, protocol: string): DirectoryLimits | null {
  const item = record(value);
  if (!item) return null;
  const top = record(item.top_provider);
  const limits = record(item.limit) ?? record(item.limits);
  const contextValues = [
    item.context_length,
    item.context_window,
    item.contextWindow,
    item.max_model_len,
    item.max_context_length,
    top?.context_length,
    limits?.context,
  ];
  const inputValues = [
    item.max_input_tokens,
    item.maxInputTokens,
    item.inputTokenLimit,
    item.input_token_limit,
    item.max_prompt_tokens,
    limits?.input,
  ];
  const outputValues = [
    item.max_output_tokens,
    item.maxOutputTokens,
    item.outputTokenLimit,
    item.output_token_limit,
    item.max_completion_tokens,
    top?.max_completion_tokens,
    limits?.output,
    protocol === "anthropic" ? item.max_tokens : undefined,
  ];
  if (
    [...contextValues, ...inputValues, ...outputValues].some(
      (value) =>
        value != null &&
        (typeof value !== "number" ||
          !Number.isSafeInteger(value) ||
          value < 1 ||
          value > 16_777_216),
    )
  )
    return null;
  return {
    contextWindow: smallest(...contextValues),
    maxInputTokens: smallest(...inputValues),
    maxOutputTokens: smallest(...outputValues),
  };
}

/** Provider directories are optional, untrusted capability reports. Never infer from a name. */
export function parseDirectoryContext(
  value: unknown,
  protocol: string,
  fetchedAt = Date.now(),
): ModelContextMetadata | null {
  const limits = parseDirectoryLimits(value, protocol);
  if (!limits) return null;
  const { contextWindow, maxInputTokens, maxOutputTokens } = limits;
  if (!contextWindow && !maxInputTokens) return null;
  return normalizeModelContextMetadata({
    contextWindow: contextWindow ?? maxInputTokens,
    ...(maxInputTokens ? { maxInputTokens } : {}),
    ...(maxOutputTokens ? { maxOutputTokens } : {}),
    ...(!contextWindow && maxInputTokens ? { inputLimitOnly: true } : {}),
    source: "channel",
    fetchedAt,
  });
}

async function readBoundedJson(response: Response): Promise<unknown> {
  if (!response.ok) throw new Error(`Model directory unavailable (${response.status})`);
  const length = Number(response.headers.get("content-length"));
  if (length > MAX_RESPONSE_BYTES) throw new Error("Model directory is too large");
  if (!response.body) throw new Error("Model directory is empty");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.length;
      if (bytes > MAX_RESPONSE_BYTES) throw new Error("Model directory is too large");
      chunks.push(chunk.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const all = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.length;
  }
  return JSON.parse(new TextDecoder().decode(all));
}

export interface DiscoveredModel {
  modelId: string;
  displayName: string;
  contextMetadata: ModelContextMetadata | null;
}

/** Same-origin pagination only: credentials cannot follow a directory-provided foreign URL. */
export async function fetchModelDirectory(
  input: {
    protocol: string;
    url: string;
    headers: Record<string, string>;
  },
  options: { timeoutMs?: number } = {},
): Promise<DiscoveredModel[]> {
  const signal = AbortSignal.timeout(
    Math.min(FETCH_TIMEOUT_MS, Math.max(1, options.timeoutMs ?? FETCH_TIMEOUT_MS)),
  );
  const initialUrl = new URL(input.url);
  let url = initialUrl;
  const seen = new Set<string>();
  const models = new Map<string, DiscoveredModel>();
  let inspected = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    if (seen.has(url.href)) throw new Error("Model directory pagination repeated");
    seen.add(url.href);
    const json = record(
      await readBoundedJson(
        await fetchModelMetadata(url.href, {
          headers: input.headers,
          signal,
          redirect: "error",
        }),
      ),
    );
    if (!json) throw new Error("Invalid model directory");
    const entries = input.protocol === "google" ? json.models : json.data;
    if (!Array.isArray(entries)) throw new Error("Invalid model directory entries");
    inspected += entries.length;
    if (inspected > MAX_MODELS) throw new Error("Too many directory entries");
    const fetchedAt = Date.now();
    for (const entry of entries) {
      const item = record(entry);
      if (!item) throw new Error("Invalid model directory entry");
      if (
        input.protocol === "google" &&
        Array.isArray(item.supportedGenerationMethods) &&
        !item.supportedGenerationMethods.includes("generateContent")
      )
        continue;
      const rawId = input.protocol === "google" ? item.name : item.id;
      if (typeof rawId !== "string" || !rawId.trim())
        throw new Error("Invalid model directory identifier");
      const modelId = input.protocol === "google" ? rawId.replace(/^models\//, "") : rawId;
      const label = item.display_name ?? item.displayName ?? item.name;
      models.set(modelId, {
        modelId,
        displayName: typeof label === "string" ? label : modelId,
        contextMetadata: parseDirectoryContext(item, input.protocol, fetchedAt),
      });
      if (models.size > MAX_MODELS) throw new Error("Too many directory models");
    }
    let next: URL | null = null;
    const pageToken = json.nextPageToken ?? json.next_page_token;
    const nextLink = json.next ?? record(json.links)?.next;
    if (typeof pageToken === "string" && pageToken) {
      next = new URL(url);
      next.searchParams.set("pageToken", pageToken);
    } else if (typeof nextLink === "string" && nextLink) {
      next = new URL(nextLink, url);
    } else if (json.has_more === true) {
      const cursor = json.last_id ?? record(entries.at(-1))?.id;
      if (typeof cursor !== "string" || !cursor) throw new Error("Missing model directory cursor");
      next = new URL(url);
      next.searchParams.set(input.protocol === "anthropic" ? "after_id" : "after", cursor);
    } else if (typeof json.next_cursor === "string" && json.next_cursor) {
      next = new URL(url);
      next.searchParams.set("cursor", json.next_cursor);
    }
    if (!next) return [...models.values()];
    if (next.origin !== initialUrl.origin)
      throw new Error("Foreign model directory pagination URL");
    url = next;
  }
  throw new Error("Model directory pagination limit reached");
}

type CatalogEntry = { canonicalId: string; modelId: string; metadata: ModelContextMetadata };
let catalogEntries: CatalogEntry[] = [];
let catalogExpiresAt = 0;
let catalogRetryAt = 0;
let catalogInFlight: Promise<CatalogEntry[]> | null = null;

/** Accept both the lightweight canonical directory and the older provider map. */
export function parseContextCatalog(json: unknown, fetchedAt = Date.now()): CatalogEntry[] {
  const root = record(json);
  if (!root) return [];
  const entries: CatalogEntry[] = [];
  const append = (canonicalId: string, value: unknown) => {
    const model = record(value);
    const limits = record(model?.limit);
    if (!model || !limits) return;
    const metadata = normalizeModelContextMetadata({
      contextWindow: limits.context,
      ...(limits.input != null ? { maxInputTokens: limits.input } : {}),
      ...(limits.output != null ? { maxOutputTokens: limits.output } : {}),
      source: "catalog",
      fetchedAt,
    });
    if (!metadata || !canonicalId) return;
    const modelId =
      typeof model.id === "string" ? model.id : canonicalId.split("/").slice(1).join("/");
    entries.push({ canonicalId, modelId, metadata });
  };
  for (const [key, value] of Object.entries(root)) {
    const item = record(value);
    if (!item) continue;
    const models = record(item.models);
    if (models) {
      const provider = typeof item.id === "string" ? item.id : key;
      for (const [modelId, model] of Object.entries(models)) {
        append(modelId.startsWith(`${provider}/`) ? modelId : `${provider}/${modelId}`, model);
      }
    } else {
      append(key, item);
    }
    if (entries.length > MAX_MODELS) break;
  }
  return entries.slice(0, MAX_MODELS);
}

export function matchContextCatalog(
  entries: CatalogEntry[],
  modelId: string,
  provider?: string,
): ModelContextMetadata | null {
  const exact = entries.find((entry) => entry.canonicalId === modelId);
  if (exact) return exact.metadata;
  if (provider) {
    const preferred = entries.find(
      (entry) => entry.canonicalId === `${provider.toLowerCase()}/${modelId}`,
    );
    if (preferred) return preferred.metadata;
  }
  const matching = entries.filter(
    (entry) =>
      entry.modelId === modelId ||
      entry.canonicalId.slice(entry.canonicalId.indexOf("/") + 1) === modelId,
  );
  if (!matching.length) return null;
  const first = matching[0].metadata;
  return matching.every(
    (entry) =>
      entry.metadata.contextWindow === first.contextWindow &&
      entry.metadata.maxInputTokens === first.maxInputTokens &&
      entry.metadata.maxOutputTokens === first.maxOutputTokens,
  )
    ? first
    : null;
}

export function loadContextCatalog(options: { force?: boolean } = {}): Promise<CatalogEntry[]> {
  const now = Date.now();
  if (catalogInFlight) return catalogInFlight;
  if (!options.force && (now < catalogExpiresAt || now < catalogRetryAt))
    return Promise.resolve(catalogEntries);
  catalogInFlight = Promise.resolve().then(async () => {
    try {
      // A fixed public endpoint, no provider authentication, and no redirects.
      const parsed = parseContextCatalog(
        await readBoundedJson(
          await fetchModelMetadata(CATALOG_URL, {
            headers: {
              Accept: "application/json",
              "User-Agent": "OpenHorn/1.0 context-capabilities",
            },
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
            redirect: "error",
          }),
        ),
      );
      if (!parsed.length) throw new Error("Empty context catalog");
      catalogEntries = parsed;
      catalogExpiresAt = Date.now() + CONTEXT_METADATA_TTL_MS;
      catalogRetryAt = 0;
    } catch {
      catalogRetryAt = Date.now() + FAILURE_BACKOFF_MS;
    } finally {
      catalogInFlight = null;
    }
    return catalogEntries;
  });
  return catalogInFlight;
}

const endpointCache = new Map<
  string,
  {
    expires: number;
    metadata: ModelContextMetadata | null;
    pending?: Promise<ModelContextMetadata | null>;
  }
>();

/** Selected model only, never an N-request probe of the entire OpenRouter list. */
export function loadOpenRouterModelContext(
  modelId: string,
  options: { force?: boolean } = {},
): Promise<ModelContextMetadata | null> {
  const cached = endpointCache.get(modelId);
  if (cached?.pending) return cached.pending;
  if (!options.force && cached && cached.expires > Date.now())
    return Promise.resolve(cached.metadata);
  const state = {
    expires: 0,
    metadata: cached?.metadata ?? null,
    pending: undefined as Promise<ModelContextMetadata | null> | undefined,
  };
  state.pending = Promise.resolve().then(async () => {
    try {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*\/[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(modelId)) return null;
      const path = modelId.split("/").map(encodeURIComponent).join("/");
      const json = record(
        await readBoundedJson(
          await fetchModelMetadata(`https://openrouter.ai/api/v1/models/${path}/endpoints`, {
            headers: { Accept: "application/json" },
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
            redirect: "error",
          }),
        ),
      );
      const data = record(json?.data);
      if (!Array.isArray(data?.endpoints) || !data.endpoints.length)
        throw new Error("No endpoint metadata");
      const candidates = data.endpoints
        .map((value) => parseDirectoryLimits(value, "openai"))
        .filter((value): value is DirectoryLimits => Boolean(value));
      const contextWindow = smallest(...candidates.map((value) => value.contextWindow));
      const maxInputTokens = smallest(...candidates.map((value) => value.maxInputTokens));
      const metadata = normalizeModelContextMetadata({
        contextWindow: contextWindow ?? maxInputTokens,
        maxInputTokens,
        maxOutputTokens: smallest(...candidates.map((value) => value.maxOutputTokens)),
        ...(!contextWindow && maxInputTokens ? { inputLimitOnly: true } : {}),
        source: "channel",
        fetchedAt: Date.now(),
      });
      if (!metadata) throw new Error("No endpoint limits");
      state.metadata = metadata;
      state.expires = Date.now() + CONTEXT_METADATA_TTL_MS;
    } catch {
      state.expires = Date.now() + FAILURE_BACKOFF_MS;
    } finally {
      state.pending = undefined;
    }
    return state.metadata;
  });
  endpointCache.set(modelId, state);
  if (endpointCache.size > 256) {
    const oldest = endpointCache.keys().next().value;
    if (oldest) endpointCache.delete(oldest);
  }
  return state.pending;
}

/** Expire only these public model reports, retaining last-good limits on failure. */
export function invalidateOpenRouterModelContexts(modelIds: readonly string[]): void {
  for (const modelId of modelIds) {
    const cached = endpointCache.get(modelId);
    if (cached) cached.expires = 0;
  }
  // In-flight reads remain shared, including forced reads; they are not canceled.
}

export function resetContextDiscoveryCaches(): void {
  catalogEntries = [];
  catalogExpiresAt = 0;
  catalogRetryAt = 0;
  catalogInFlight = null;
  endpointCache.clear();
}
