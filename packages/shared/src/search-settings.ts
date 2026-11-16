/** Browser-safe settings keys; do not import server search transports into the desktop UI. */
export const TAVILY_SEARCH_RUNTIME_KEY = "liveSearch.tavilyRuntimeApiKey";
export const TAVILY_ACTIVE_SEARCH_CONFIG = "liveSearch.activeTavilyConfig";

import type { SearchExecutionSource } from "./types/search-settings";

/** Validate only safe provider identifiers, dropping arbitrary remote metadata. */
export function readSearchExecutionSource(value: unknown): SearchExecutionSource | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  if (
    typeof source.provider !== "string" ||
    !["tavily", "deepseek", "deepseek-native", "openrouter", "duckduckgo"].includes(source.provider)
  )
    return undefined;
  if (
    source.fallbackFrom !== undefined &&
    (source.provider !== "duckduckgo" || source.fallbackFrom !== "tavily")
  )
    return undefined;
  return {
    provider: source.provider as SearchExecutionSource["provider"],
    ...(source.fallbackFrom === "tavily" ? { fallbackFrom: "tavily" as const } : {}),
  };
}
