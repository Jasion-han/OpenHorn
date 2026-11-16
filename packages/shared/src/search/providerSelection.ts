/** Explicit choices never borrow another provider's credential. Auto is legacy Tavily → DDG. */
export type PreferredSearchProvider =
  | "auto"
  | "tavily"
  | "deepseek"
  | "deepseek-native"
  | "openrouter"
  | "duckduckgo";
export { TAVILY_ACTIVE_SEARCH_CONFIG, TAVILY_SEARCH_RUNTIME_KEY } from "../search-settings";
export type SearchProviderSelection =
  | { provider: "tavily" | "deepseek" | "deepseek-native" | "openrouter"; apiKey: string }
  | { provider: "duckduckgo" }
  | { provider: "none"; reason: "not_configured" | "invalid_provider" };

export function selectSearchProvider(options: {
  searchProvider?: string;
  tavilyApiKey?: string | null;
  deepseekApiKey?: string | null;
  nativeSearchApiKey?: string | null;
  openRouterSearchApiKey?: string | null;
}): SearchProviderSelection {
  const provider = options.searchProvider ?? "auto";
  const tavily = options.tavilyApiKey?.trim();
  const deepseek = options.deepseekApiKey?.trim();
  switch (provider) {
    case "auto":
      return tavily ? { provider: "tavily", apiKey: tavily } : { provider: "duckduckgo" };
    case "tavily":
      return tavily ? { provider, apiKey: tavily } : { provider: "none", reason: "not_configured" };
    case "deepseek":
      return deepseek
        ? { provider, apiKey: deepseek }
        : { provider: "none", reason: "not_configured" };
    case "deepseek-native":
      return options.nativeSearchApiKey?.trim()
        ? { provider, apiKey: options.nativeSearchApiKey.trim() }
        : { provider: "none", reason: "not_configured" };
    case "duckduckgo":
      return { provider };
    case "openrouter":
      return options.openRouterSearchApiKey?.trim()
        ? { provider, apiKey: options.openRouterSearchApiKey.trim() }
        : { provider: "none", reason: "not_configured" };
    default:
      return { provider: "none", reason: "invalid_provider" };
  }
}
