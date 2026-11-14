import type { SearchCitation } from "../search/types";

export type NativeWebOptions = { search: boolean; readUrls: boolean; thinking: boolean };

/** Opaque provider transcript. Never trim or rewrite a signature within this state. */
export type ProviderChatState = {
  provider: "deepseek";
  origin: string;
  model: string;
  serverToolCalls: Record<string, unknown>[];
};

/** Each callback/event carries a full snapshot, rather than a metadata delta. */
export type ProviderChatMetadata = {
  providerState?: ProviderChatState;
  citations?: SearchCitation[];
  steps?: Array<{
    id: string;
    action: string;
    status: string;
    query?: string;
    url?: string;
    title?: string;
  }>;
  refused?: boolean;
  toolUsage?: { search: number; fetch: number; imageSearch: number };
};
