import {
  buildTavilyPayload,
  isNewsQuery,
  normalizeCitations,
  normalizeSearchQuery,
  rerankCitations,
  type SearchCitation,
  searchDuckDuckGo,
  type TavilyResult,
} from "shared/search";
import type { LiveRouteType } from "./liveCapabilities";

// Re-exported so existing consumers (e.g. liveCapabilities.ts) keep importing
// the citation type from this module.
export type { SearchCitation };

export const TAVILY_API_KEY_SETTING = "liveSearch.tavilyApiKey";
export const TAVILY_ENABLED_SETTING = "liveSearch.tavilyEnabled";

export type SearchProvider = "tavily" | "duckduckgo" | "none";

export type SearchContextResult = {
  status: "live" | "offline";
  label: string;
  systemContext?: string;
  citations: SearchCitation[];
  provider: SearchProvider;
  degradedToDirectModel?: boolean;
};

export type BuildSearchContextInput = {
  route: Extract<LiveRouteType, "web_search" | "research">;
  prompt: string;
  userSettings?: Record<string, string>;
  envKey?: string | null;
  fetchImpl?: FetchFn;
  timeoutMs?: number;
  /** Clock override for deterministic freshness re-ranking in tests. */
  now?: () => number;
};

type FetchFn = (
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

  const lines = citations
    .flatMap((citation, index) => {
      const prefix = `[${index + 1}]`;
      return [
        `${prefix} title: ${citation.title}`,
        `${prefix} url: ${citation.url}`,
        citation.publishedDate ? `${prefix} published_date: ${citation.publishedDate}` : null,
        citation.snippet ? `${prefix} snippet: ${citation.snippet}` : null,
      ];
    })
    .filter((line): line is string => Boolean(line));

  const instruction =
    route === "research"
      ? "Synthesize across sources, mention uncertainty when sources disagree, and cite sources inline with [n] only. Do not append a final References, Sources, or 引用 section."
      : "Answer using only these search results, stay concise, and cite sources inline with [n] only. Do not append a final References, Sources, or 引用 section.";

  return [header, `Query: ${prompt}`, ...lines, instruction].join("\n");
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
  // Provider selection: a configured Tavily key (user > server env) wins for
  // quality, but only when Tavily is enabled (pickApiKey returns null when the
  // "启用 Tavily" toggle is off). Otherwise fall back to the keyless DuckDuckGo
  // provider so search still works for users who disabled Tavily or never
  // configured a key.
  const apiKey = pickApiKey(input);
  if (apiKey) {
    return runTavilySearch(input, apiKey);
  }
  return runDuckDuckGoSearch(input);
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

  const citations = rerankCitations(rawCitations, isNewsQuery(input.prompt), input.now);
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
    const citations = rerankCitations(normalizeCitations(data.results), isNews, input.now);
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
