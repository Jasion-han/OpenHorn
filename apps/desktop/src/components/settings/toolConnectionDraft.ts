import { DEEPSEEK_SEARCH_CONNECTION, parseDeepSeekSearchConfig } from "shared/deepseek-search";
import {
  LEGACY_TOOL_KEY,
  parseToolConnectionConfig,
  TOOL_CONNECTION_SETTING,
  toolBaseUrl,
} from "shared/tool-connection";

export type ToolConnectionDraft = {
  source: "manual" | "channel";
  baseUrl: string;
  key: string;
  channelId: string;
};
export const emptyToolConnection: ToolConnectionDraft = {
  source: "manual",
  baseUrl: toolBaseUrl("deepseek"),
  key: "",
  channelId: "",
};
export const sameToolDraft = (a: ToolConnectionDraft, b: ToolConnectionDraft) =>
  a.source === b.source &&
  a.baseUrl === b.baseUrl &&
  a.key === b.key &&
  a.channelId === b.channelId;
export function loadToolDraft(settings: Record<string, string>): ToolConnectionDraft {
  const raw = settings[DEEPSEEK_SEARCH_CONNECTION] ?? settings[TOOL_CONNECTION_SETTING];
  if (raw !== undefined) {
    const config =
      settings[DEEPSEEK_SEARCH_CONNECTION] !== undefined
        ? parseDeepSeekSearchConfig(raw)
        : parseToolConnectionConfig(raw);
    if (config.kind !== "deepseek") return { ...emptyToolConnection };
    return {
      source: config.source,
      baseUrl: config.source === "manual" ? config.baseUrl : toolBaseUrl("deepseek"),
      key: config.source === "manual" ? config.apiKey : "",
      channelId: config.source === "channel" ? config.channelId : "",
    };
  }
  const key = settings[LEGACY_TOOL_KEY] ?? "";
  return key ? { ...emptyToolConnection, source: "manual", key } : { ...emptyToolConnection };
}
export function serializeToolDraft(draft: ToolConnectionDraft): string {
  return JSON.stringify(
    parseDeepSeekSearchConfig(
      JSON.stringify({
        kind: "deepseek",
        source: draft.source,
        baseUrl: draft.baseUrl.trim(),
        apiKey: draft.key.trim(),
        channelId: draft.channelId,
      }),
    ),
  );
}
export const isToolDraftReady = (draft: ToolConnectionDraft) =>
  draft.source === "channel" ? Boolean(draft.channelId) : Boolean(draft.key.trim());
