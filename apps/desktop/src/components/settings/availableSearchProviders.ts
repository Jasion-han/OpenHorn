import type { SearchEngine } from "shared/types";

const supported = new Set<SearchEngine>([
  "tavily",
  "deepseek-native",
  "openrouter",
  "deepseek",
  "duckduckgo",
]);
/** Preserve saved connections; verification is a status, never a reason to hide legacy setup. */
export function availableSearchProviders(
  providers: readonly SearchEngine[] | undefined,
  current: string,
  configured: readonly SearchEngine[] = [],
): SearchEngine[] {
  const verified = new Set(providers ?? []);
  const unique = [...new Set([...configured, ...(providers ?? [])])].filter((provider) =>
    supported.has(provider),
  );
  if (unique.includes("deepseek") && unique.includes("deepseek-native")) {
    const preferred =
      current === "deepseek" || current === "deepseek-native"
        ? current
        : verified.has("deepseek-native")
          ? "deepseek-native"
          : verified.has("deepseek")
            ? "deepseek"
            : "deepseek-native";
    return unique.filter(
      (provider) => provider !== (preferred === "deepseek" ? "deepseek-native" : "deepseek"),
    );
  }
  return unique;
}
