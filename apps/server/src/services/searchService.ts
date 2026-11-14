import {
  buildTavilyPayload,
  fetchDeepSeek,
  formatUntrustedWebSources,
  isNewsQuery,
  normalizeCitations,
  normalizeSearchQuery,
  type ResolveWebHostname,
  rerankCitations,
  type SearchCitation,
  searchDeepSeek,
  searchDuckDuckGo,
  selectSearchProvider,
  type TavilyResult,
} from "shared/search";
import { decisionEnhancements } from "./decisionEnhancements";
import type { LiveRouteType } from "./liveCapabilities";

// Re-exported so existing consumers (e.g. liveCapabilities.ts) keep importing
// the citation type from this module.
export type { SearchCitation };

export const TAVILY_API_KEY_SETTING = "liveSearch.tavilyApiKey";
export const TAVILY_ENABLED_SETTING = "liveSearch.tavilyEnabled";

export const DEEPSEEK_TOOLS_API_KEY_SETTING = "deepseek.toolsApiKey";
export const SEARCH_PROVIDER_SETTING = "liveSearch.provider";
export const SEARCH_SETTINGS_KEYS = [
  TAVILY_API_KEY_SETTING,
  TAVILY_ENABLED_SETTING,
  DEEPSEEK_TOOLS_API_KEY_SETTING,
  SEARCH_PROVIDER_SETTING,
] as const;

export type SearchProvider = "tavily" | "deepseek" | "duckduckgo" | "none";

export type SearchContextResult = {
  status: "live" | "offline";
  label: string;
  systemContext?: string;
  citations: SearchCitation[];
  provider: SearchProvider;
  degradedToDirectModel?: boolean;
};

export type BuildSearchContextInput = {
  userId?: string;
  route: Extract<LiveRouteType, "web_search" | "research">;
  prompt: string;
  userSettings?: Record<string, string>;
  envKey?: string | null;
  fetchImpl?: FetchFn;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Clock override for deterministic freshness re-ranking in tests. */
  now?: () => number;
};

export type FetchFn = (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
) => ReturnType<typeof fetch>;

const DEFAULT_FETCH: FetchFn = fetch;
const DEFAULT_SEARCH_TIMEOUT_MS = 4_000;
const DEFAULT_RESEARCH_TIMEOUT_MS = 5_000;

function getSearchRouteName(route: BuildSearchContextInput["route"]) {
  return route === "research" ? "在线研究" : "实时搜索";
}

function buildFailureLabel(
  route: BuildSearchContextInput["route"],
  reason: "disabled" | "not_configured" | "timeout" | "upstream_error" | "no_results" | "failed",
  detail?: string,
) {
  const name = getSearchRouteName(route);
  switch (reason) {
    case "disabled":
      return `${name}已关闭，任务无法继续`;
    case "not_configured":
      return `${name}未配置，任务无法继续`;
    case "timeout":
      return `${name}超时，任务已停止`;
    case "upstream_error":
      return detail ? `${name}失败（${detail}），任务已停止` : `${name}失败，任务已停止`;
    case "no_results":
      return `${name}未返回可用来源，任务已停止`;
    default:
      return `${name}失败，任务已停止`;
  }
}

function isTavilyEnabled(input: BuildSearchContextInput) {
  const raw = input.userSettings?.[TAVILY_ENABLED_SETTING];
  if (raw == null) return true;
  return String(raw).trim().toLowerCase() !== "false";
}

function pickApiKey(input: BuildSearchContextInput) {
  if (!isTavilyEnabled(input)) {
    return null;
  }
  const userKey = input.userSettings?.[TAVILY_API_KEY_SETTING]?.trim();
  if (userKey) return userKey;
  const envKey = input.envKey?.trim();
  if (envKey) return envKey;
  return null;
}

const PROVIDER_DISPLAY_NAME: Record<Exclude<SearchProvider, "none">, string> = {
  tavily: "Tavily",
  deepseek: "DeepSeek",
  duckduckgo: "DuckDuckGo",
};

function buildSystemContext(
  route: BuildSearchContextInput["route"],
  prompt: string,
  citations: SearchCitation[],
  provider: Exclude<SearchProvider, "none">,
) {
  const providerName = PROVIDER_DISPLAY_NAME[provider];
  const header =
    route === "research"
      ? `${providerName} live research results:`
      : `${providerName} live search results:`;

  const instruction =
    route === "research"
      ? "Synthesize across sources, mention uncertainty when sources disagree, and cite sources inline with [n] only. Do not append a final References, Sources, or 引用 section."
      : "Answer using only these search results, stay concise, and cite sources inline with [n] only. Do not append a final References, Sources, or 引用 section.";

  return [header, `Query: ${prompt}`, instruction, formatUntrustedWebSources(citations)].join("\n");
}

function buildOfflineResult(
  label: string,
  systemContext: string,
  options?: { degradedToDirectModel?: boolean },
): SearchContextResult {
  return {
    status: "offline",
    label,
    systemContext,
    citations: [],
    provider: "none",
    degradedToDirectModel: Boolean(options?.degradedToDirectModel),
  };
}

export async function buildSearchContext(
  input: BuildSearchContextInput,
): Promise<SearchContextResult> {
  const selected = selectSearchProvider({
    searchProvider: input.userSettings?.[SEARCH_PROVIDER_SETTING],
    tavilyApiKey: pickApiKey(input),
    deepseekApiKey: input.userSettings?.[DEEPSEEK_TOOLS_API_KEY_SETTING],
  });
  if (selected.provider === "none") {
    return buildOfflineResult(
      buildFailureLabel(
        input.route,
        selected.reason === "not_configured" ? "not_configured" : "failed",
      ),
      "Live search is not configured. Do not claim you searched the web or cite sources.",
      { degradedToDirectModel: true },
    );
  }
  if (selected.provider === "deepseek") return runDeepSeekSearch(input, selected.apiKey);
  if (selected.provider === "tavily") return runTavilySearch(input, selected.apiKey);
  return runDuckDuckGoSearch(input);
}

async function runDeepSeekSearch(
  input: BuildSearchContextInput,
  apiKey: string,
): Promise<SearchContextResult> {
  try {
    const sources = await searchDeepSeek(normalizeSearchQuery(input.prompt), {
      apiKey,
      fetchImpl: input.fetchImpl,
      signal: input.signal,
      timeoutMs:
        input.timeoutMs ??
        (input.route === "research" ? DEFAULT_RESEARCH_TIMEOUT_MS : DEFAULT_SEARCH_TIMEOUT_MS),
      maxResults: input.route === "research" ? 8 : 5,
    });
    if (!sources.length) {
      return buildOfflineResult(
        buildFailureLabel(input.route, "no_results"),
        "Live search returned no usable sources. Do not claim you searched the web or cite sources.",
        { degradedToDirectModel: true },
      );
    }
    const ordered = rerankCitations(sources, isNewsQuery(input.prompt), input.now);
    const citations = input.userId
      ? await decisionEnhancements.rerank(
          input.userId,
          input.prompt,
          ordered,
          (item) => `${item.title}\n${item.summary ?? item.snippet ?? ""}`,
        )
      : ordered;
    return {
      status: "live",
      label: input.route === "research" ? "已使用研究搜索" : "已使用实时搜索",
      provider: "deepseek",
      citations,
      systemContext: buildSystemContext(input.route, input.prompt, citations, "deepseek"),
    };
  } catch (error) {
    const timeout = error instanceof Error && error.message === "timeout";
    return buildOfflineResult(
      buildFailureLabel(input.route, timeout ? "timeout" : "failed"),
      `Live search ${timeout ? "timed out" : "failed"}. Do not claim you searched the web or cite sources.`,
      { degradedToDirectModel: true },
    );
  }
}

export type BuildLinkContextInput = {
  urls: string[];
  webSearchEnabled?: boolean;
  userSettings?: Record<string, string>;
  fetchImpl?: FetchFn;
  timeoutMs?: number;
  signal?: AbortSignal;
  resolveHostname?: ResolveWebHostname;
};

/** Main/Native Chat preparation supplies explicit URLs only after its data-only/network gate. */
export async function buildLinkContext(input: BuildLinkContextInput): Promise<SearchContextResult> {
  const apiKey = input.userSettings?.[DEEPSEEK_TOOLS_API_KEY_SETTING]?.trim();
  if (input.webSearchEnabled !== true || !apiKey || !input.urls.length || input.signal?.aborted) {
    return buildOfflineResult(
      "链接未读取",
      "Web pages were not read. Do not claim to have read their contents.",
    );
  }
  const citations: SearchCitation[] = [];
  let failed = 0;
  for (const url of [...new Set(input.urls)].slice(0, 3)) {
    if (input.signal?.aborted) break;
    try {
      citations.push(
        await fetchDeepSeek(url, {
          apiKey,
          fetchImpl: input.fetchImpl,
          timeoutMs: input.timeoutMs,
          signal: input.signal,
          resolveHostname: input.resolveHostname,
        }),
      );
    } catch {
      failed++;
    }
  }
  if (input.signal?.aborted || !citations.length) {
    return buildOfflineResult(
      "链接未读取",
      "Web page reading failed. Do not claim to have read the pages or cite their contents.",
    );
  }
  return {
    status: "live",
    label: "已读取链接",
    provider: "deepseek",
    citations,
    systemContext: [
      "Web page reading results. Cite only pages present in the following source data.",
      failed || new Set(input.urls).size > 3
        ? "Some requested pages were not read. Do not claim to have read all requested pages."
        : "",
      formatUntrustedWebSources(citations),
    ]
      .filter(Boolean)
      .join("\n"),
  };
}

async function runDuckDuckGoSearch(input: BuildSearchContextInput): Promise<SearchContextResult> {
  const rawCitations = await searchDuckDuckGo(normalizeSearchQuery(input.prompt), {
    fetchImpl: input.fetchImpl,
    timeoutMs: input.timeoutMs,
    maxResults: input.route === "research" ? 8 : 5,
    now: input.now,
  });

  if (rawCitations.length === 0) {
    return buildOfflineResult(
      buildFailureLabel(input.route, "no_results"),
      "Live search returned no usable sources. Do not claim you searched the web or cite sources. State that the answer may be outdated.",
      { degradedToDirectModel: true },
    );
  }

  const ordered = rerankCitations(rawCitations, isNewsQuery(input.prompt), input.now);
  const citations = input.userId
    ? await decisionEnhancements.rerank(
        input.userId,
        input.prompt,
        ordered,
        (item) => `${item.title}\n${item.snippet ?? ""}`,
      )
    : ordered;
  return {
    status: "live",
    label: input.route === "research" ? "已使用研究搜索" : "已使用实时搜索",
    systemContext: buildSystemContext(input.route, input.prompt, citations, "duckduckgo"),
    citations,
    provider: "duckduckgo",
  };
}

/**
 * Tavily failure fallback: try the keyless DuckDuckGo provider so search still
 * works. Returns a live DDG result when it has sources, otherwise null so the
 * caller can keep its original offline degradation.
 */
async function degradeToDuckDuckGo(
  input: BuildSearchContextInput,
): Promise<SearchContextResult | null> {
  const result = await runDuckDuckGoSearch(input);
  return result.status === "live" ? result : null;
}

async function runTavilySearch(
  input: BuildSearchContextInput,
  apiKey: string,
): Promise<SearchContextResult> {
  const isResearch = input.route === "research";
  const isNews = isNewsQuery(input.prompt);
  const payload = buildTavilyPayload(input.prompt, { route: input.route });

  try {
    const timeoutMs =
      input.timeoutMs ?? (isResearch ? DEFAULT_RESEARCH_TIMEOUT_MS : DEFAULT_SEARCH_TIMEOUT_MS);
    const response = await (input.fetchImpl || DEFAULT_FETCH)("https://api.tavily.com/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
      const fallback = await degradeToDuckDuckGo(input);
      if (fallback) return fallback;
      return buildOfflineResult(
        buildFailureLabel(input.route, "upstream_error", `HTTP ${response.status}`),
        "Live search failed. Do not claim you searched the web or cite sources. State that the answer may be outdated.",
        { degradedToDirectModel: true },
      );
    }

    const data = (await response.json()) as { results?: TavilyResult[] };
    const ordered = rerankCitations(normalizeCitations(data.results), isNews, input.now);
    const citations = input.userId
      ? await decisionEnhancements.rerank(
          input.userId,
          input.prompt,
          ordered,
          (item) => `${item.title}\n${item.snippet ?? ""}`,
        )
      : ordered;
    if (citations.length === 0) {
      const fallback = await degradeToDuckDuckGo(input);
      if (fallback) return fallback;
      return buildOfflineResult(
        buildFailureLabel(input.route, "no_results"),
        "Live search returned no usable sources. Do not claim you searched the web or cite sources. State that the answer may be outdated.",
        { degradedToDirectModel: true },
      );
    }

    return {
      status: "live",
      label: isResearch ? "已使用研究搜索" : "已使用实时搜索",
      systemContext: buildSystemContext(input.route, input.prompt, citations, "tavily"),
      citations,
      provider: "tavily",
    };
  } catch (error) {
    const fallback = await degradeToDuckDuckGo(input);
    if (fallback) return fallback;
    const isTimeout = error instanceof Error && error.name === "TimeoutError";
    return buildOfflineResult(
      buildFailureLabel(input.route, isTimeout ? "timeout" : "failed"),
      isTimeout
        ? "Live search timed out. Do not claim you searched the web or cite sources. Answer directly and state that the answer may be outdated."
        : "Live search failed. Do not claim you searched the web or cite sources. State that the answer may be outdated.",
      { degradedToDirectModel: true },
    );
  }
}
