import type { SearchCitation } from "./types";

// DuckDuckGo keyless fallback provider.
//
// Why this exists: high-quality search APIs (Tavily, Brave, Serper) all require
// an API key. To keep search working for end users who never configure a key,
// we fall back to DuckDuckGo's keyless `lite` HTML endpoint. It is best-effort:
// no official search API, frequent `202` soft rate-limits, and snippets rarely
// carry a publish date — callers must treat freshness as weak for this provider
// (see research/keyless-search-options.md).

export type DuckDuckGoFetchFn = (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
) => ReturnType<typeof fetch>;

export type SearchDuckDuckGoOptions = {
  fetchImpl?: DuckDuckGoFetchFn;
  timeoutMs?: number;
  maxResults?: number;
  /** Override for tests; defaults to the real clock. */
  now?: () => number;
  /** Soft-ratelimit retry budget. */
  maxRetries?: number;
  /** Sleep hook (ms) — overridable in tests to avoid real delays. */
  sleep?: (ms: number) => Promise<void>;
};

const DDG_LITE_ENDPOINT = "https://lite.duckduckgo.com/lite/";
const DEFAULT_TIMEOUT_MS = 4_000;
const DEFAULT_MAX_RESULTS = 8;
const DEFAULT_MAX_RETRIES = 2;
const CACHE_TTL_MS = 5 * 60_000;

const DEFAULT_FETCH: DuckDuckGoFetchFn = fetch;
const DEFAULT_NOW = () => Date.now();
const DEFAULT_SLEEP = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

type CacheEntry = { at: number; citations: SearchCitation[] };
const responseCache = new Map<string, CacheEntry>();

/** Exposed for tests that need a clean slate. */
export function __clearDuckDuckGoCache() {
  responseCache.clear();
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function stripTags(value: string): string {
  return decodeHtmlEntities(value.replace(/<[^>]*>/g, ""))
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * DDG `lite` links are sometimes direct https URLs and sometimes a
 * `//duckduckgo.com/l/?uddg=<encoded>` redirect — normalize both to a real URL.
 */
function resolveResultUrl(href: string): string {
  const raw = href.trim();
  if (!raw) return "";
  const uddg = raw.match(/[?&]uddg=([^&]+)/);
  if (uddg) {
    try {
      return decodeURIComponent(uddg[1]);
    } catch {
      return "";
    }
  }
  if (raw.startsWith("//")) return `https:${raw}`;
  if (raw.startsWith("http://") || raw.startsWith("https://")) return raw;
  return "";
}

/** Best-effort parse of the DDG lite HTML result table into citations. */
export function parseDuckDuckGoLiteHtml(html: string, maxResults: number): SearchCitation[] {
  const anchorRe = /<a\b([^>]*?)>([\s\S]*?)<\/a>/gi;
  const snippetRe = /<td\b[^>]*class=["']?result-snippet["']?[^>]*>([\s\S]*?)<\/td>/gi;

  const snippets: string[] = [];
  let snippetMatch: RegExpExecArray | null = snippetRe.exec(html);
  while (snippetMatch !== null) {
    snippets.push(stripTags(snippetMatch[1]));
    snippetMatch = snippetRe.exec(html);
  }

  const citations: SearchCitation[] = [];
  let anchorMatch: RegExpExecArray | null = anchorRe.exec(html);
  let resultIndex = 0;
  while (anchorMatch !== null && citations.length < maxResults) {
    const attrs = anchorMatch[1];
    if (/class=["']?result-link["']?/.test(attrs)) {
      const hrefMatch = attrs.match(/href=["']([^"']+)["']/);
      const url = hrefMatch ? resolveResultUrl(hrefMatch[1]) : "";
      const title = stripTags(anchorMatch[2]);
      if (url && title) {
        citations.push({
          title,
          url,
          snippet: snippets[resultIndex] || undefined,
        });
      }
      resultIndex += 1;
    }
    anchorMatch = anchorRe.exec(html);
  }
  return citations;
}

function isSoftRateLimited(status: number): boolean {
  return status === 202 || status === 429;
}

/**
 * Keyless DuckDuckGo search. Returns up to `maxResults` citations, or an empty
 * array when DDG is unavailable / rate-limited. Never throws for upstream
 * failures — the caller decides how to degrade.
 */
export async function searchDuckDuckGo(
  query: string,
  options: SearchDuckDuckGoOptions = {},
): Promise<SearchCitation[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];

  const fetchImpl = options.fetchImpl || DEFAULT_FETCH;
  const now = options.now || DEFAULT_NOW;
  const sleep = options.sleep || DEFAULT_SLEEP;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxResults = options.maxResults ?? DEFAULT_MAX_RESULTS;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;

  const cacheKey = `${trimmed}::${maxResults}`;
  const cached = responseCache.get(cacheKey);
  if (cached && now() - cached.at < CACHE_TTL_MS) {
    return cached.citations;
  }

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      const response = await fetchImpl(DDG_LITE_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          // A browser-like UA reduces the chance of an immediate soft block.
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
        },
        body: new URLSearchParams({ q: trimmed }).toString(),
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (isSoftRateLimited(response.status)) {
        if (attempt < maxRetries) {
          // Exponential backoff with jitter to ride out `202` soft-blocks.
          await sleep(150 * 2 ** attempt + Math.floor(Math.random() * 120));
          continue;
        }
        return [];
      }

      if (!response.ok) return [];

      const html = await response.text();
      const citations = parseDuckDuckGoLiteHtml(html, maxResults);
      responseCache.set(cacheKey, { at: now(), citations });
      return citations;
    } catch {
      // Timeout / network error — try again if we still have budget.
      if (attempt < maxRetries) {
        await sleep(150 * 2 ** attempt + Math.floor(Math.random() * 120));
        continue;
      }
      return [];
    }
  }
  return [];
}
