import {
  parseToolConnectionConfig,
  readToolRuntime,
  type ToolConnection,
  type ToolConnectionConfig,
} from "./tool-connection";

export const DEEPSEEK_SEARCH_CONNECTION = "deepseek.searchConnection";
export const DEEPSEEK_SEARCH_RUNTIME = "deepseek.searchRuntime";
export const DEEPSEEK_ACTIVE_SEARCH_CONNECTION = "deepseek.activeSearchConnection";

/** This configuration changes the access route, never the search engine. */
export function parseDeepSeekSearchConfig(raw: string): ToolConnectionConfig {
  const config = parseToolConnectionConfig(raw);
  if (config.kind !== "deepseek") throw new Error("deepseek_search_source_required");
  return config.source === "channel"
    ? { kind: "deepseek", source: "channel", channelId: config.channelId }
    : { kind: "deepseek", source: "manual", baseUrl: config.baseUrl, apiKey: config.apiKey };
}

export function readDeepSeekSearchRuntime(
  settings: Record<string, string>,
): ToolConnection | undefined {
  if (Object.hasOwn(settings, DEEPSEEK_SEARCH_RUNTIME)) {
    if (!settings[DEEPSEEK_SEARCH_RUNTIME]) return undefined;
    try {
      const config = parseDeepSeekSearchConfig(
        JSON.stringify({ ...JSON.parse(settings[DEEPSEEK_SEARCH_RUNTIME]), source: "manual" }),
      );
      return config.source === "manual" && config.apiKey ? config : undefined;
    } catch {
      return undefined;
    }
  }
  const legacy = readToolRuntime(settings);
  return legacy?.kind === "deepseek" ? legacy : undefined;
}
