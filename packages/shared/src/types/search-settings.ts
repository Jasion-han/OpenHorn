export type SearchEngine = "tavily" | "deepseek" | "deepseek-native" | "openrouter" | "duckduckgo";
/** Per-call runtime provenance; never inferred from the current settings or model prose. */
export type SearchExecutionSource = { provider: SearchEngine; fallbackFrom?: "tavily" };
export type SearchVerification = "verified" | "unverified" | "unavailable" | "not_required";
export interface SearchSettingsStatus {
  configured: boolean;
  source: "user" | "server" | "deepseek" | "deepseek-native" | "openrouter" | "duckduckgo" | "none";
  selectedProvider: SearchEngine | "auto";
  effectiveProvider: SearchEngine | "none";
  verification: SearchVerification;
  pendingProviders: Array<"tavily" | "deepseek" | "deepseek-native" | "openrouter">;
  /** Verified active connections only; candidates and keyless assumptions are not availability proof. */
  availableProviders?: SearchEngine[];
  /** Existing saved connections remain visible even before adopting newer verification records. */
  configuredProviders?: SearchEngine[];
  openRouterConnection?: { model: string; endpoint: string; engine: "exa" };
  nativeConnection?: {
    source: "manual" | "channel";
    channelName?: string;
    model: string;
    endpoint: string;
  };
  verifiedAt?: string;
  /** Opaque snapshot of the saved configuration; never an upstream credential. */
  revision: string;
}
export type SearchActivationError =
  | "search_not_configured"
  | "search_configuration_changed"
  | "search_verification_in_progress"
  | "search_auth_failed"
  | "search_endpoint_unsupported"
  | "search_rate_limited"
  | "search_timeout"
  | "search_invalid_response"
  | "search_not_executed"
  | "search_no_results"
  | "search_request_failed";
export interface SearchActivationRequest {
  provider: SearchEngine;
  revision: string;
}
export interface SearchSettingsConfiguration {
  settings: Record<string, string>;
  status: SearchSettingsStatus;
  nativeChannels?: import("../deepseek-native-search").NativeSearchChannelOption[];
  nativeSearchAvailable?: boolean;
  openRouterSearchAvailable?: boolean;
}
export type SearchActivationResult =
  | { success: true; status: SearchSettingsStatus }
  | { success: false; errorCode: SearchActivationError };
