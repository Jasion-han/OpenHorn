// Curated source registry — a provider-agnostic list of high-quality domains
// (international + Chinese) used for two things:
//
//   1. Trust re-ranking (provider-agnostic): after a search, results are
//      re-scored so trustworthy hosts float up. Works for Tavily and DuckDuckGo
//      alike — it only reads the citation `url` + `publishedDate`.
//   2. Tavily category soft-targeting: when a query maps to a clear category we
//      pass that category's top domains as `include_domains` (≤ ~12 per query,
//      never the full list — see research/curated-sources.md "不泛滥").
//
// Trust tiers map editorial confidence to a weight: 很高 = 1.0, 高 = 0.8, 中 = 0.5.
// Untrusted / unknown hosts get a 0.3 baseline in `trustScore` (not zero, to
// avoid culling good sources that simply aren't on the list).

export type SourceCategory = "news" | "tech" | "finance" | "science" | "dev";

type CuratedSource = { domain: string; trust: number; lang: "en" | "zh" };

export const CURATED_SOURCES: Record<SourceCategory, CuratedSource[]> = {
  // 1.1 通用 / 突发新闻
  news: [
    // 国际
    { domain: "reuters.com", trust: 1.0, lang: "en" },
    { domain: "apnews.com", trust: 1.0, lang: "en" },
    { domain: "afp.com", trust: 1.0, lang: "en" },
    { domain: "bbc.com", trust: 1.0, lang: "en" },
    { domain: "theguardian.com", trust: 0.8, lang: "en" },
    { domain: "nytimes.com", trust: 1.0, lang: "en" },
    { domain: "washingtonpost.com", trust: 0.8, lang: "en" },
    { domain: "aljazeera.com", trust: 0.8, lang: "en" },
    { domain: "npr.org", trust: 0.8, lang: "en" },
    { domain: "economist.com", trust: 1.0, lang: "en" },
    { domain: "axios.com", trust: 0.8, lang: "en" },
    { domain: "politico.com", trust: 0.8, lang: "en" },
    // 中文
    { domain: "thepaper.cn", trust: 0.8, lang: "zh" },
    { domain: "news.cn", trust: 0.8, lang: "zh" },
    { domain: "people.com.cn", trust: 0.8, lang: "zh" },
    { domain: "caixin.com", trust: 1.0, lang: "zh" },
    { domain: "jiemian.com", trust: 0.8, lang: "zh" },
    { domain: "yicai.com", trust: 0.8, lang: "zh" },
    { domain: "ce.cn", trust: 0.5, lang: "zh" },
  ],
  // 1.2 科技
  tech: [
    // 国际
    { domain: "techcrunch.com", trust: 0.8, lang: "en" },
    { domain: "theverge.com", trust: 0.8, lang: "en" },
    { domain: "arstechnica.com", trust: 1.0, lang: "en" },
    { domain: "wired.com", trust: 0.8, lang: "en" },
    { domain: "technologyreview.com", trust: 1.0, lang: "en" },
    { domain: "news.ycombinator.com", trust: 0.5, lang: "en" },
    { domain: "theinformation.com", trust: 1.0, lang: "en" },
    { domain: "engadget.com", trust: 0.5, lang: "en" },
    { domain: "restofworld.org", trust: 0.8, lang: "en" },
    { domain: "404media.co", trust: 0.8, lang: "en" },
    // 中文
    { domain: "ithome.com", trust: 0.8, lang: "zh" },
    { domain: "36kr.com", trust: 0.8, lang: "zh" },
    { domain: "huxiu.com", trust: 0.8, lang: "zh" },
    { domain: "sspai.com", trust: 0.8, lang: "zh" },
    { domain: "geekpark.net", trust: 0.5, lang: "zh" },
    { domain: "pingwest.com", trust: 0.5, lang: "zh" },
    { domain: "tmtpost.com", trust: 0.5, lang: "zh" },
    { domain: "leiphone.com", trust: 0.5, lang: "zh" },
  ],
  // 1.3 财经 / 市场
  finance: [
    // 国际
    { domain: "bloomberg.com", trust: 1.0, lang: "en" },
    { domain: "wsj.com", trust: 1.0, lang: "en" },
    { domain: "ft.com", trust: 1.0, lang: "en" },
    { domain: "cnbc.com", trust: 0.8, lang: "en" },
    { domain: "marketwatch.com", trust: 0.5, lang: "en" },
    { domain: "barrons.com", trust: 0.8, lang: "en" },
    { domain: "fortune.com", trust: 0.8, lang: "en" },
    // 中文
    { domain: "caixin.com", trust: 1.0, lang: "zh" },
    { domain: "yicai.com", trust: 0.8, lang: "zh" },
    { domain: "wallstreetcn.com", trust: 0.8, lang: "zh" },
    { domain: "cls.cn", trust: 0.8, lang: "zh" },
    { domain: "stcn.com", trust: 0.8, lang: "zh" },
    { domain: "eastmoney.com", trust: 0.5, lang: "zh" },
  ],
  // 1.4 科学 / 研究
  science: [
    { domain: "nature.com", trust: 1.0, lang: "en" },
    { domain: "science.org", trust: 1.0, lang: "en" },
    { domain: "arxiv.org", trust: 0.8, lang: "en" },
    { domain: "pnas.org", trust: 1.0, lang: "en" },
    { domain: "cell.com", trust: 1.0, lang: "en" },
    { domain: "thelancet.com", trust: 1.0, lang: "en" },
    { domain: "nejm.org", trust: 1.0, lang: "en" },
    { domain: "quantamagazine.org", trust: 1.0, lang: "en" },
    { domain: "scientificamerican.com", trust: 0.8, lang: "en" },
    { domain: "newscientist.com", trust: 0.8, lang: "en" },
    { domain: "biorxiv.org", trust: 0.5, lang: "en" },
  ],
  // 1.5 开发者 / AI（官方博客 + 一手）
  dev: [
    { domain: "github.com", trust: 0.8, lang: "en" },
    { domain: "github.blog", trust: 0.8, lang: "en" },
    { domain: "openai.com", trust: 1.0, lang: "en" },
    { domain: "anthropic.com", trust: 1.0, lang: "en" },
    { domain: "deepmind.google", trust: 1.0, lang: "en" },
    { domain: "research.google", trust: 1.0, lang: "en" },
    { domain: "blog.google", trust: 0.8, lang: "en" },
    { domain: "ai.meta.com", trust: 0.8, lang: "en" },
    { domain: "huggingface.co", trust: 0.8, lang: "en" },
    { domain: "developer.mozilla.org", trust: 1.0, lang: "en" },
    { domain: "stackoverflow.com", trust: 0.5, lang: "en" },
    { domain: "devblogs.microsoft.com", trust: 0.8, lang: "en" },
    { domain: "aws.amazon.com", trust: 0.8, lang: "en" },
    { domain: "jiqizhixin.com", trust: 0.8, lang: "zh" },
    { domain: "qbitai.com", trust: 0.5, lang: "zh" },
  ],
};

// Multi-part public suffixes we must look past to find the registrable label.
const MULTI_PART_TLDS = new Set([
  "co.uk",
  "org.uk",
  "ac.uk",
  "gov.uk",
  "com.cn",
  "net.cn",
  "org.cn",
  "gov.cn",
  "com.au",
  "co.jp",
  "co.kr",
  "com.hk",
]);

function stripCommonSubdomain(host: string): string {
  return host.replace(/^www\./, "").replace(/^m\./, "");
}

/**
 * Registrable label for a hostname, e.g. `bbc.com` / `m.bbc.com` / `bbc.co.uk`
 * all collapse to `bbc`. Used so subdomain/TLD variants of a curated host still
 * match during trust scoring.
 */
function mainDomainLabel(host: string): string {
  const parts = stripCommonSubdomain(host).split(".").filter(Boolean);
  if (parts.length <= 1) return parts[0] ?? "";
  const lastTwo = `${parts[parts.length - 2]}.${parts[parts.length - 1]}`;
  if (MULTI_PART_TLDS.has(lastTwo) && parts.length >= 3) {
    return parts[parts.length - 3];
  }
  return parts[parts.length - 2];
}

/**
 * Flat host → trust index, derived from CURATED_SOURCES. When the same domain
 * appears in multiple categories (e.g. caixin.com in news + finance) the highest
 * trust wins. Keys are the bare hostnames as listed (no protocol / path).
 */
export const TRUST_BY_HOST: Map<string, number> = (() => {
  const map = new Map<string, number>();
  for (const sources of Object.values(CURATED_SOURCES)) {
    for (const { domain, trust } of sources) {
      const prev = map.get(domain);
      if (prev === undefined || trust > prev) map.set(domain, trust);
    }
  }
  return map;
})();

// Secondary index keyed by registrable label, for subdomain/TLD-variant matches.
const TRUST_BY_LABEL: Map<string, number> = (() => {
  const map = new Map<string, number>();
  for (const [domain, trust] of TRUST_BY_HOST) {
    const label = mainDomainLabel(domain);
    if (!label) continue;
    const prev = map.get(label);
    if (prev === undefined || trust > prev) map.set(label, trust);
  }
  return map;
})();

const TRUST_BASELINE = 0.3;

/**
 * Trust weight for a result URL. Exact host match wins; otherwise a registrable
 * label match (handles `m.`/`www.` and TLD variants); otherwise the 0.3 baseline
 * (never zero — unknown hosts must not be culled). Malformed URLs → baseline.
 */
export function trustScore(url: string): number {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return TRUST_BASELINE;
  }
  const stripped = stripCommonSubdomain(host);
  const exact = TRUST_BY_HOST.get(stripped);
  if (exact !== undefined) return exact;
  const byLabel = TRUST_BY_LABEL.get(mainDomainLabel(host));
  if (byLabel !== undefined) return byLabel;
  return TRUST_BASELINE;
}

const DEFAULT_CATEGORY_DOMAINS = 12;

/**
 * Top domains for a category, capped at `max` (default 12) to keep Tavily
 * `include_domains` focused rather than flooding it with the full list.
 */
export function domainsForCategory(
  cat: SourceCategory,
  opts: { max?: number; lang?: "en" | "zh" } = {},
): string[] {
  const { max = DEFAULT_CATEGORY_DOMAINS, lang } = opts;
  const list = lang
    ? CURATED_SOURCES[cat].filter((source) => source.lang === lang)
    : CURATED_SOURCES[cat];
  return list.slice(0, Math.max(0, max)).map((source) => source.domain);
}

// Ordered most-specific → least-specific so e.g. "今天科技新闻" maps to `tech`
// (not the generic `news` bucket). Ambiguous queries fall through to null.
const CATEGORY_PATTERNS: { category: SourceCategory; pattern: RegExp }[] = [
  {
    category: "finance",
    pattern:
      /财经|财报|股市|股票|金融|基金|证券|行情|经济|央行|美联储|加息|降息|融资|IPO|stock market|finance|earnings|nasdaq|dow jones/i,
  },
  {
    category: "science",
    pattern:
      /科学|科研|学术|论文|期刊|临床|医学|arxiv|biorxiv|study|research paper|physics|biology|chemistry/i,
  },
  {
    category: "dev",
    pattern:
      /编程|代码|程序员|开源|github|大模型|prompt 工程|API 文档|sdk|framework|programming|developer|open source/i,
  },
  {
    category: "tech",
    pattern:
      /科技|数码|芯片|半导体|手机|硬件|软件|互联网|新品发布|tech|gadget|smartphone|chip|semiconductor/i,
  },
  {
    category: "news",
    pattern: /新闻|时事|突发|头条|发生了什么|最新消息|最新动态|刚刚|today|news|breaking/i,
  },
];

/**
 * Map a query to one curated category, or null when it is too generic / mixed
 * to target confidently (the caller then sends no `include_domains`).
 */
export function classifyCategory(prompt: string): SourceCategory | null {
  for (const { category, pattern } of CATEGORY_PATTERNS) {
    if (pattern.test(prompt)) return category;
  }
  return null;
}
