// Provider-agnostic search core: query normalization, news detection, citation
// normalization, trust + freshness re-ranking, and Tavily payload construction.
// Shared by the server (`searchService.ts`) and the sidecar (`direct.ts`) so the
// two search paths stay behaviorally identical.

import { classifyCategory, domainsForCategory, trustScore } from "./curatedSources";
import type { SearchCitation, SearchRoute, TavilyPayload, TavilyResult } from "./types";

const DEFAULT_NOW = () => Date.now();
const DAY_MS = 24 * 60 * 60 * 1_000;
const CATEGORY_DOMAIN_CAP = 12;

export function isNewsQuery(prompt: string): boolean {
  return /新闻|最新|最近|刚刚|today|latest|news|recent|发生了什么/i.test(prompt);
}

export function normalizeSearchQuery(prompt: string): string {
  const trimmed = prompt.trim();
  if (!trimmed) return trimmed;

  const compact = trimmed
    .replace(/请联网搜索|联网搜索|帮我查一下|帮我搜一下|查一下|搜一下/g, " ")
    .replace(/并给我一句总结|给我一句总结|顺便总结一下|再总结一下/g, " ")
    .replace(/[，。！？]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (
    /openai/i.test(compact) &&
    /responses api/i.test(compact) &&
    /官网|官方网站|官方文档|official|文档|docs/i.test(compact)
  ) {
    return 'site:developers.openai.com/api/reference/responses/overview OR site:platform.openai.com/docs/api-reference/responses "Responses Overview" "OpenAI"';
  }

  if (/openai/i.test(compact) && /官网|官方网站|官方文档|official/i.test(compact)) {
    return `site:developers.openai.com OR site:platform.openai.com -site:community.openai.com -site:help.openai.com ${compact}`;
  }

  return compact;
}

export function normalizeCitations(results: TavilyResult[] | undefined): SearchCitation[] {
  return (results || [])
    .map((result) => ({
      title: result.title?.trim() || result.url?.trim() || "Untitled source",
      url: result.url?.trim() || "",
      snippet: result.content?.trim() || undefined,
      publishedDate: result.published_date?.trim() || undefined,
    }))
    .filter((result) => result.url.length > 0);
}

function freshnessScore(publishedDate: string | undefined, isNews: boolean, nowMs: number): number {
  if (!publishedDate) return 0.5;
  const ts = Date.parse(publishedDate);
  if (Number.isNaN(ts)) return 0.5;
  const days = Math.max(0, (nowMs - ts) / DAY_MS);
  if (isNews) {
    if (days <= 1) return 1.0;
    if (days <= 2) return 0.85;
    if (days <= 7) return 0.6;
    if (days <= 30) return 0.3;
    return 0.1;
  }
  if (days <= 7) return 1.0;
  if (days <= 30) return 0.7;
  if (days <= 180) return 0.4;
  return 0.2;
}

/**
 * Provider-agnostic re-rank: re-score citations by trust + freshness + original
 * rank so trustworthy / recent sources float up. Applied to both Tavily and
 * DuckDuckGo results (DDG rarely has a publishedDate, so its freshness defaults
 * to the neutral 0.5 and trust dominates). Stable, descending; never drops a
 * result (avoids clearing the set).
 */
export function rerankCitations(
  citations: SearchCitation[],
  isNews: boolean,
  now: () => number = DEFAULT_NOW,
): SearchCitation[] {
  if (citations.length <= 1) return citations;
  const nowMs = now();
  return citations
    .map((citation, index) => {
      const trust = trustScore(citation.url);
      const freshness = freshnessScore(citation.publishedDate, isNews, nowMs);
      const rank = 1 / (index + 1);
      const score = 0.5 * trust + 0.3 * freshness + 0.2 * rank;
      return { citation, score, index };
    })
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.citation);
}

/**
 * Build the Tavily `/search` request body (without auth). Applies the freshness
 * optimizations: news queries go to `topic:news` + `time_range:day`; research
 * uses `advanced` depth + a `month` window; a clear category soft-targets that
 * category's top domains via `include_domains` (capped to avoid flooding).
 */
export function buildTavilyPayload(
  prompt: string,
  opts: { route: SearchRoute; includeAnswer?: boolean },
): TavilyPayload {
  const isResearch = opts.route === "research";
  const isNews = isNewsQuery(prompt);
  const category = classifyCategory(prompt);
  const includeDomains = category
    ? domainsForCategory(category, { max: CATEGORY_DOMAIN_CAP })
    : undefined;

  return {
    query: normalizeSearchQuery(prompt),
    topic: isNews ? "news" : "general",
    search_depth: isResearch ? "advanced" : "basic",
    max_results: isResearch ? 8 : 5,
    include_answer: opts.includeAnswer ?? false,
    include_raw_content: false,
    // chunks_per_source only takes effect with search_depth=advanced (research).
    ...(isResearch ? { chunks_per_source: 3 } : {}),
    // News queries tighten to "day" for freshness; research keeps a "month"
    // window; plain queries stay unfiltered.
    time_range: isResearch ? "month" : isNews ? "day" : undefined,
    ...(includeDomains ? { include_domains: includeDomains } : {}),
  };
}
