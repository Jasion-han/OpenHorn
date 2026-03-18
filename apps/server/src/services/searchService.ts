import type { LiveRouteType } from "./liveCapabilities";

export const TAVILY_API_KEY_SETTING = "liveSearch.tavilyApiKey";
export const TAVILY_ENABLED_SETTING = "liveSearch.tavilyEnabled";

export type SearchCitation = {
  title: string;
  url: string;
  snippet?: string;
  publishedDate?: string;
};

export type SearchContextResult = {
  status: "live" | "offline";
  label: string;
  systemContext?: string;
  citations: SearchCitation[];
  provider: "tavily" | "none";
};

export type BuildSearchContextInput = {
  route: Extract<LiveRouteType, "web_search" | "research">;
  prompt: string;
  userSettings?: Record<string, string>;
  envKey?: string | null;
  fetchImpl?: FetchFn;
};

type FetchFn = (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
) => ReturnType<typeof fetch>;

type TavilyResult = {
  title?: string;
  url?: string;
  content?: string;
  published_date?: string;
};

const DEFAULT_FETCH: FetchFn = fetch;

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

function isNewsQuery(prompt: string) {
  return /新闻|最新|最近|刚刚|today|latest|news|recent|发生了什么/i.test(prompt);
}

function normalizeCitations(results: TavilyResult[] | undefined): SearchCitation[] {
  return (results || [])
    .map((result) => ({
      title: result.title?.trim() || result.url?.trim() || "Untitled source",
      url: result.url?.trim() || "",
      snippet: result.content?.trim() || undefined,
      publishedDate: result.published_date?.trim() || undefined,
    }))
    .filter((result) => result.url.length > 0);
}

function buildSystemContext(
  route: BuildSearchContextInput["route"],
  prompt: string,
  citations: SearchCitation[],
) {
  const header =
    route === "research" ? "Tavily live research results:" : "Tavily live search results:";

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
      ? "Synthesize across sources, mention uncertainty when sources disagree, and cite the sources you used."
      : "Answer using only these search results, stay concise, and cite the sources you used.";

  return [header, `Query: ${prompt}`, ...lines, instruction].join("\n");
}

function buildOfflineResult(label: string, systemContext: string): SearchContextResult {
  return {
    status: "offline",
    label,
    systemContext,
    citations: [],
    provider: "none",
  };
}

export async function buildSearchContext(
  input: BuildSearchContextInput,
): Promise<SearchContextResult> {
  if (!isTavilyEnabled(input)) {
    return buildOfflineResult(
      "实时搜索已关闭，本轮为离线回答",
      "Live search is disabled for this user. Do not claim you searched the web or cite sources. State that the answer may be outdated.",
    );
  }

  const apiKey = pickApiKey(input);
  if (!apiKey) {
    return buildOfflineResult(
      "实时搜索未配置，本轮为离线回答",
      "Live search is not configured. Do not claim you searched the web or cite sources. State that the answer may be outdated.",
    );
  }

  const payload = {
    query: input.prompt,
    topic: isNewsQuery(input.prompt) ? "news" : "general",
    search_depth: "advanced",
    max_results: input.route === "research" ? 8 : 5,
    chunks_per_source: 3,
    include_answer: false,
    include_raw_content: false,
    time_range:
      input.route === "research" ? "month" : isNewsQuery(input.prompt) ? "week" : undefined,
  };

  try {
    const response = await (input.fetchImpl || DEFAULT_FETCH)("https://api.tavily.com/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      return buildOfflineResult(
        "实时搜索暂不可用，本轮为离线回答",
        "Live search failed. Do not claim you searched the web or cite sources. State that the answer may be outdated.",
      );
    }

    const data = (await response.json()) as { results?: TavilyResult[] };
    const citations = normalizeCitations(data.results);
    if (citations.length === 0) {
      return buildOfflineResult(
        "实时搜索暂不可用，本轮为离线回答",
        "Live search returned no usable sources. Do not claim you searched the web or cite sources. State that the answer may be outdated.",
      );
    }

    return {
      status: "live",
      label: input.route === "research" ? "已使用研究搜索" : "已使用实时搜索",
      systemContext: buildSystemContext(input.route, input.prompt, citations),
      citations,
      provider: "tavily",
    };
  } catch {
    return buildOfflineResult(
      "实时搜索暂不可用，本轮为离线回答",
      "Live search failed. Do not claim you searched the web or cite sources. State that the answer may be outdated.",
    );
  }
}
