/** Browser-safe, independent OpenRouter retrieval credentials. Never reads Jev settings. */
export const OPENROUTER_SEARCH_CONFIG = "openrouter.searchConnection";
export const OPENROUTER_SEARCH_ACTIVE = "openrouter.activeSearchConnection";
export const OPENROUTER_SEARCH_RUNTIME = "openrouter.searchRuntime";
export const OPENROUTER_SEARCH_MODEL = "deepseek/deepseek-v4-flash";
// Explicit legacy models retain their verified fingerprints until a replacement passes.
export const OPENROUTER_SEARCH_MODELS = [
  OPENROUTER_SEARCH_MODEL,
  "deepseek/deepseek-v4-pro",
] as const;
export type OpenRouterSearchModel = (typeof OPENROUTER_SEARCH_MODELS)[number];
export const isOpenRouterSearchModel = (value: unknown): value is OpenRouterSearchModel =>
  OPENROUTER_SEARCH_MODELS.some((model) => model === value);
export const OPENROUTER_SEARCH_BASE_URL = "https://openrouter.ai/api/v1";
export const OPENROUTER_SEARCH_ENGINE = "exa";
export type OpenRouterSearchConnection = {
  apiKey: string;
  baseUrl: typeof OPENROUTER_SEARCH_BASE_URL;
  model: OpenRouterSearchModel;
  engine: typeof OPENROUTER_SEARCH_ENGINE;
};
export function parseOpenRouterSearchConfig(raw: string): OpenRouterSearchConnection {
  if (raw.length > 10_000) throw new Error("invalid_openrouter_search_config");
  const value = JSON.parse(raw);
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    typeof value.apiKey !== "string" ||
    !value.apiKey.trim() ||
    value.apiKey.length > 4096 ||
    /\s/.test(value.apiKey) ||
    value.apiKey.startsWith("__cli_oauth__:") ||
    (value.baseUrl !== undefined && value.baseUrl !== OPENROUTER_SEARCH_BASE_URL) ||
    (value.model !== undefined && !isOpenRouterSearchModel(value.model)) ||
    (value.engine !== undefined && value.engine !== OPENROUTER_SEARCH_ENGINE)
  )
    throw new Error("invalid_openrouter_search_config");
  return {
    apiKey: value.apiKey,
    baseUrl: OPENROUTER_SEARCH_BASE_URL,
    model: value.model ?? OPENROUTER_SEARCH_MODEL,
    engine: OPENROUTER_SEARCH_ENGINE,
  };
}
export function readOpenRouterSearchRuntime(
  settings: Record<string, string>,
): OpenRouterSearchConnection | undefined {
  try {
    const value = JSON.parse(settings[OPENROUTER_SEARCH_RUNTIME] ?? "null");
    if (
      !value ||
      value.baseUrl !== OPENROUTER_SEARCH_BASE_URL ||
      !isOpenRouterSearchModel(value.model) ||
      value.engine !== OPENROUTER_SEARCH_ENGINE
    )
      return undefined;
    return parseOpenRouterSearchConfig(JSON.stringify(value));
  } catch {
    return undefined;
  }
}
