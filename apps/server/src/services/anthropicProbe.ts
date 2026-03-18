import { summarizeProviderError } from "./providerErrorSummary";

export type AnthropicProbeResult =
  | { success: true }
  | {
      success: false;
      error: string;
      reason: "auth" | "model" | "not_found" | "rate_limit" | "server" | "request" | "timeout" | "network";
    };

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "");
}

function normalizeAnthropicApiBaseUrl(baseUrl: string): string {
  let url = normalizeBaseUrl(baseUrl);
  url = url.replace(/\/messages$/, "");
  if (!url.match(/\/v\d+$/)) {
    url = `${url}/v1`;
  }
  return url;
}

function looksLikeModelError(text: string) {
  const lower = text.toLowerCase();
  if (!lower.includes("model")) return false;
  return [
    "model_not_found",
    "unsupported_model",
    "invalid model",
    "unknown model",
    "model not found",
    "does not exist",
    "unsupported",
    "not available",
  ].some((pattern) => lower.includes(pattern));
}

export async function probeAnthropicModel(
  baseUrl: string,
  apiKey: string,
  modelId: string,
  options?: { timeoutMs?: number },
): Promise<AnthropicProbeResult> {
  const timeoutMs = options?.timeoutMs ?? 10_000;

  try {
    const response = await fetch(`${normalizeAnthropicApiBaseUrl(baseUrl)}/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: modelId,
        max_tokens: 1,
        messages: [{ role: "user", content: "hi" }],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (response.ok) {
      return { success: true };
    }

    const text = await response.text().catch(() => "");
    const summary = summarizeProviderError(text, {
      status: response.status,
      fallback: `Request failed (${response.status})`,
    });

    if (response.status === 400 && looksLikeModelError(text)) {
      return { success: false, reason: "model", error: summary };
    }
    if (response.status === 401 || response.status === 403) {
      return { success: false, reason: "auth", error: summary };
    }
    if (response.status === 404) {
      return {
        success: false,
        reason: "not_found",
        error: "该渠道不支持 Anthropic /v1/messages 接口（返回 404）。",
      };
    }
    if (response.status === 429) {
      return { success: false, reason: "rate_limit", error: summary };
    }
    if (response.status >= 500) {
      return { success: false, reason: "server", error: summary };
    }

    return { success: false, reason: "request", error: summary };
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      return {
        success: false,
        reason: "timeout",
        error: `连接超时（${Math.round(timeoutMs / 1000)}s），请检查 Base URL 是否正确。`,
      };
    }
    return {
      success: false,
      reason: "network",
      error: error instanceof Error ? error.message : "连接失败",
    };
  }
}
