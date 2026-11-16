/** Browser-safe contracts for the independent native-web retrieval channel. */
export const NATIVE_SEARCH_CONFIG = "deepseek.nativeSearchConnection";
export const NATIVE_SEARCH_ACTIVE = "deepseek.activeNativeSearchConnection";
export const NATIVE_SEARCH_RUNTIME = "deepseek.nativeSearchRuntime";
export const NATIVE_SEARCH_MODEL = "deepseek-v4-pro";
export const NATIVE_SEARCH_BASE_URL = "https://api.deepseek.com/v1";
export type NativeSearchConnection = { apiKey: string; baseUrl: string; model: string };
export type NativeSearchConfig = {
  model: typeof NATIVE_SEARCH_MODEL;
  baseUrl: typeof NATIVE_SEARCH_BASE_URL;
} & ({ source: "manual"; apiKey: string } | { source: "channel"; channelId: string });
export type NativeSearchChannelOption = { channelId: string; name: string; model: string };

export function isNativeSearchEndpoint(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    return (
      url.origin === "https://api.deepseek.com" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      ["/", "/v1", "/v1/"].includes(url.pathname)
    );
  } catch {
    return false;
  }
}
export function parseNativeSearchConfig(raw: string): NativeSearchConfig {
  if (raw.length > 10_000) throw new Error("invalid_native_search_config");
  const value = JSON.parse(raw);
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (value.model !== undefined && value.model !== NATIVE_SEARCH_MODEL) ||
    (value.baseUrl !== undefined && !isNativeSearchEndpoint(value.baseUrl))
  )
    throw new Error("invalid_native_search_config");
  if (
    value.source === "channel" &&
    typeof value.channelId === "string" &&
    value.channelId.trim() &&
    value.channelId.length <= 200
  )
    return {
      source: "channel",
      channelId: value.channelId,
      model: NATIVE_SEARCH_MODEL,
      baseUrl: NATIVE_SEARCH_BASE_URL,
    };
  if (
    value.source !== "manual" ||
    typeof value.apiKey !== "string" ||
    !value.apiKey.trim() ||
    value.apiKey.length > 4096 ||
    /\s/.test(value.apiKey)
  )
    throw new Error("invalid_native_search_config");
  return {
    source: "manual",
    apiKey: value.apiKey,
    model: NATIVE_SEARCH_MODEL,
    baseUrl: NATIVE_SEARCH_BASE_URL,
  };
}
export function readNativeSearchRuntime(
  settings: Record<string, string>,
): NativeSearchConnection | undefined {
  try {
    const value = JSON.parse(settings[NATIVE_SEARCH_RUNTIME] ?? "null");
    if (!value || value.model !== NATIVE_SEARCH_MODEL || !isNativeSearchEndpoint(value.baseUrl))
      return undefined;
    const config = parseNativeSearchConfig(JSON.stringify({ ...value, source: "manual" }));
    return config.source === "manual"
      ? { apiKey: config.apiKey, baseUrl: NATIVE_SEARCH_BASE_URL, model: NATIVE_SEARCH_MODEL }
      : undefined;
  } catch {
    return undefined;
  }
}
