/** Browser-safe configuration contracts; runtime DNS checks live in search/. */
export type ToolConnection = {
  kind: "deepseek" | "openrouter";
  baseUrl: string;
  apiKey: string;
  model?: string;
};
export type ToolConnectionConfig =
  | (ToolConnection & { source: "manual" })
  | { kind: ToolConnection["kind"]; source: "channel"; channelId: string; model?: string };
export const TOOL_CONNECTION_SETTING = "tools.connection";
export const TOOL_RUNTIME_SETTING = "tools.runtime";
export const LEGACY_TOOL_KEY = "deepseek.toolsApiKey";
export type ToolServiceStatus = {
  configured: boolean;
  kind?: ToolConnection["kind"];
  endpoint?: string;
  connectionToken?: string;
};
export const toolBaseUrl = (kind: ToolConnection["kind"]) =>
  kind === "openrouter" ? "https://openrouter.ai/api/v1" : "https://api.deepseek.com/v1";

export function normalizeToolBaseUrl(raw: string): string {
  if (!raw || raw.length > 2048 || /[\s\\]/.test(raw)) throw new Error("invalid_tool_endpoint");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("invalid_tool_endpoint");
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !host.includes(".") ||
    host === "localhost" ||
    /\.(localhost|local|internal|lan|home)$/.test(host) ||
    /^(127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)
  )
    throw new Error("invalid_tool_endpoint");
  const path = url.pathname.replace(/\/+$/, "") || "/v1";
  return `${url.origin}${path}`;
}

export function parseToolConnectionConfig(raw: string): ToolConnectionConfig {
  if (raw.length > 10_000) throw new Error("invalid_tool_connection");
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("invalid_tool_connection");
  }
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (value.kind !== "deepseek" && value.kind !== "openrouter")
  )
    throw new Error("invalid_tool_connection");
  const kind = value.kind;
  const model = typeof value.model === "string" ? value.model.trim() : "";
  if (model.length > 200 || /[\r\n]/.test(model) || (kind === "openrouter" && !model))
    throw new Error("tool_model_required");
  if (value.source === "channel") {
    if (
      typeof value.channelId !== "string" ||
      !value.channelId.trim() ||
      value.channelId.length > 200
    )
      throw new Error("tool_channel_required");
    return { kind, source: "channel", channelId: value.channelId, ...(model ? { model } : {}) };
  }
  if (
    value.source !== "manual" ||
    typeof value.apiKey !== "string" ||
    value.apiKey.length > 4096 ||
    /\s/.test(value.apiKey)
  )
    throw new Error("invalid_tool_key");
  return {
    kind,
    source: "manual",
    baseUrl: normalizeToolBaseUrl(String(value.baseUrl ?? "")),
    apiKey: value.apiKey,
    ...(model ? { model } : {}),
  };
}

export function readToolRuntime(settings: Record<string, string>): ToolConnection | undefined {
  if (Object.hasOwn(settings, TOOL_RUNTIME_SETTING)) {
    if (!settings[TOOL_RUNTIME_SETTING]) return undefined;
    try {
      const config = parseToolConnectionConfig(
        JSON.stringify({ ...JSON.parse(settings[TOOL_RUNTIME_SETTING]), source: "manual" }),
      );
      return config.source === "manual" && config.apiKey ? config : undefined;
    } catch {
      return undefined;
    }
  }
  const apiKey = settings[LEGACY_TOOL_KEY]?.trim();
  return apiKey ? { kind: "deepseek", baseUrl: toolBaseUrl("deepseek"), apiKey } : undefined;
}
