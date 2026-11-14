/** Explicit choices never borrow another provider's credential. Auto is legacy Tavily → DDG. */
export type PreferredSearchProvider = "auto" | "tavily" | "deepseek" | "duckduckgo";
export type SearchProviderSelection =
  | { provider: "tavily" | "deepseek"; apiKey: string }
  | { provider: "duckduckgo" }
  | { provider: "none"; reason: "not_configured" | "invalid_provider" };

export function selectSearchProvider(options: {
  searchProvider?: string;
  tavilyApiKey?: string | null;
  deepseekApiKey?: string | null;
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
    case "duckduckgo":
      return { provider };
    default:
      return { provider: "none", reason: "invalid_provider" };
  }
}
