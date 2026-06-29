// Provider-agnostic search types shared by the server and the sidecar.
//
// `SearchCitation` is the single normalized shape every provider (Tavily,
// DuckDuckGo, …) must produce so downstream re-ranking / formatting stays
// provider-independent. This module is the authoritative definition; the server
// re-exports it from `searchService.ts` for backwards compatibility.

export type SearchCitation = {
  title: string;
  url: string;
  snippet?: string;
  publishedDate?: string;
};

export type SearchRoute = "web_search" | "research";

/** Raw Tavily `/search` result item (only the fields we consume). */
export type TavilyResult = {
  title?: string;
  url?: string;
  content?: string;
  published_date?: string;
};

/** Request body for Tavily `/search` (without auth — callers add the key). */
export type TavilyPayload = {
  query: string;
  topic: "news" | "general";
  search_depth: "advanced" | "basic";
  max_results: number;
  include_answer: boolean;
  include_raw_content: boolean;
  chunks_per_source?: number;
  time_range?: string;
  include_domains?: string[];
};
