export type ProviderErrorKind =
  | "quota_exhausted"
  | "ssl_handshake_failed"
  | "gateway_failed"
  | "auth_failed"
  | "timeout"
  | "protocol_incompatible"
  | "model_not_found"
  | "request_failed"
  | "server_failed"
  | "network_failed"
  | "unknown";

export type ProviderErrorInfo = {
  kind: ProviderErrorKind;
  raw: string;
  summary: string;
  userMessage: string;
  status?: number;
  retryable: boolean;
};

function normalizeWhitespace(text: string) {
  return text.replace(/\s+/g, " ").trim();
}

function clipText(text: string, maxLen = 120) {
  if (text.length <= maxLen) return text;
  return `${text.slice(0, Math.max(0, maxLen - 1))}…`;
}

function extractHtmlTitle(text: string) {
  const match = text.match(/<title>\s*([^<]+?)\s*<\/title>/i);
  return match?.[1]?.trim() || "";
}

function stripHtml(text: string) {
  return normalizeWhitespace(text.replace(/<[^>]+>/g, " "));
}

function extractStatusCode(text: string, fallback?: number) {
  if (typeof fallback === "number") return fallback;

  const providerMatch = text.match(/provider api error\s*\((\d{3})\)/i);
  if (providerMatch?.[1]) {
    return Number.parseInt(providerMatch[1], 10);
  }

  const cloudflareMatch = text.match(/\b(\d{3})\s*:\s*[a-z][^|<]+/i);
  if (cloudflareMatch?.[1]) {
    return Number.parseInt(cloudflareMatch[1], 10);
  }

  return undefined;
}

function summarizeKnownProviderError(text: string) {
  const normalized = normalizeWhitespace(text);
  if (!normalized) return "";

  const lower = normalized.toLowerCase();
  if (lower.includes("error code 525") || lower.includes("ssl handshake failed")) {
    return "525: SSL handshake failed";
  }

  const title = extractHtmlTitle(normalized);
  if (title) {
    const cloudflareTitle = title.match(/\b(\d{3})\s*:\s*([^\|]+)\s*$/);
    if (cloudflareTitle?.[1] && cloudflareTitle?.[2]) {
      return `${cloudflareTitle[1]}: ${cloudflareTitle[2].trim()}`;
    }
    return clipText(title, 80);
  }

  const withoutTags = stripHtml(normalized);
  if (!withoutTags) return "";

  return clipText(withoutTags);
}

function buildFallbackSummary(status?: number, fallback?: string) {
  if (fallback) return fallback;
  if (typeof status === "number") return `Request failed (${status})`;
  return "Request failed";
}

function extractMeaningfulDetail(text: string, summary: string) {
  const normalized = normalizeWhitespace(text);
  if (!normalized) return summary;

  const providerMatch = normalized.match(/^Provider API error(?: \(\d{3}\))?:\s*(.+)$/i);
  if (providerMatch?.[1]) return clipText(providerMatch[1].trim(), 160);

  const title = extractHtmlTitle(normalized);
  if (title) return clipText(title, 160);

  const withoutTags = stripHtml(normalized);
  if (!withoutTags) return summary;
  return clipText(withoutTags, 160);
}

function replaceKnownDetail(detail: string) {
  return detail
    .replace(/hour allocated quota exceeded/gi, "小时配额已耗尽")
    .replace(/token quota is not enough/gi, "token 配额不足")
    .replace(/ssl handshake failed/gi, "SSL 握手失败")
    .replace(/no cookie available/gi, "缺少 Cookie")
    .replace(/invalid api key/gi, "API Key 无效")
    .replace(/unauthorized/gi, "未授权")
    .replace(/forbidden/gi, "无权访问")
    .replace(/gateway timeout/gi, "网关超时")
    .replace(/bad gateway/gi, "网关异常")
    .replace(/service unavailable/gi, "服务不可用")
    .replace(/timed out/gi, "超时")
    .replace(/\btimeout\b/gi, "超时")
    .replace(/too many requests/gi, "请求过于频繁")
    .replace(/rate limit(?:ed)?/gi, "触发限流")
    .replace(/model not found/gi, "模型不存在")
    .replace(/unsupported model/gi, "模型不受支持")
    .replace(/invalid model/gi, "模型无效")
    .replace(/does not exist/gi, "不存在")
    .replace(/request failed/gi, "请求失败");
}

function normalizeUserDetail(detail: string) {
  const translated = replaceKnownDetail(detail)
    .replace(/^Provider API error(?: \(\d{3}\))?:\s*/i, "")
    .trim();
  return translated.replace(/[。.!]+$/u, "").trim();
}

function hasAnyPattern(lower: string, patterns: string[]) {
  return patterns.some((pattern) => lower.includes(pattern));
}

function buildUserMessage(prefix: string, detail?: string, suffix?: string) {
  const normalizedDetail = detail ? normalizeUserDetail(detail) : "";
  const body = normalizedDetail ? `${prefix}：${normalizedDetail}。` : `${prefix}。`;
  if (!suffix) return body;
  return `${body}${suffix}`;
}

export function classifyProviderError(
  text: string,
  options?: {
    status?: number;
    fallback?: string;
  },
): ProviderErrorInfo {
  const raw = typeof text === "string" ? text.trim() : "";
  const summary = summarizeKnownProviderError(raw) || buildFallbackSummary(options?.status, options?.fallback);
  const detail = extractMeaningfulDetail(raw, summary);
  const normalized = normalizeWhitespace(raw || summary);
  const lower = normalized.toLowerCase();
  const status = extractStatusCode(normalized, options?.status);

  if (
    normalized.includes("不兼容 Claude Agent SDK") ||
    normalized.includes("不兼容当前 Agent 工具运行协议") ||
    normalized.includes("未检测到真实 Bash 工具调用") ||
    lower.includes("incompatible with claude agent sdk") ||
    lower.includes("incompatible with the current agent tool-calling protocol") ||
    lower.includes("no real bash tool call was detected")
  ) {
    let userMessage = normalized;
    if (lower.includes("claude agent sdk")) {
      userMessage = "该渠道支持普通聊天接口，但不兼容 Claude Agent SDK，无法用于 Agent 模式。它仍可用于普通聊天。";
    } else if (
      normalized.includes("当前 Agent 工具运行协议") ||
      lower.includes("tool execution") ||
      lower.includes("tool-calling protocol")
    ) {
      userMessage = "该渠道支持普通聊天接口，但不兼容当前 Agent 工具运行协议，无法用于 Agent 模式。它仍可用于普通聊天。";
    }
    return {
      kind: "protocol_incompatible",
      raw: raw || summary,
      summary,
      userMessage,
      status,
      retryable: false,
    };
  }

  if (
    lower.includes("compatibility_timeout") ||
    normalized.includes("超时") ||
    hasAnyPattern(lower, ["timeout", "timed out", "no output for", "no activity for"])
  ) {
    return {
      kind: "timeout",
      raw: raw || summary,
      summary,
      userMessage: buildUserMessage("连接或响应超时", detail, "请检查渠道连通性或稍后重试。"),
      status,
      retryable: true,
    };
  }

  if (status === 525 || hasAnyPattern(lower, ["ssl handshake failed", "error code 525"])) {
    return {
      kind: "ssl_handshake_failed",
      raw: raw || summary,
      summary,
      userMessage: buildUserMessage("TLS/SSL 握手失败", detail, "请检查 Base URL、证书链或中转服务。"),
      status: status ?? 525,
      retryable: false,
    };
  }

  if (
    status === 429 ||
    hasAnyPattern(lower, [
      "quota",
      "rate limit",
      "too many requests",
      "hour allocated quota exceeded",
      "token quota is not enough",
    ])
  ) {
    return {
      kind: "quota_exhausted",
      raw: raw || summary,
      summary,
      userMessage: buildUserMessage("配额不足或触发限流", detail),
      status,
      retryable: true,
    };
  }

  if (
    status === 401 ||
    status === 403 ||
    hasAnyPattern(lower, [
      "invalid api key",
      "unauthorized",
      "forbidden",
      "authentication",
      "auth failed",
      "no cookie available",
      "api key",
    ])
  ) {
    return {
      kind: "auth_failed",
      raw: raw || summary,
      summary,
      userMessage: buildUserMessage("鉴权失败", detail),
      status,
      retryable: false,
    };
  }

  if (
    status === 404 ||
    hasAnyPattern(lower, [
      "model_not_found",
      "unsupported_model",
      "model not found",
      "invalid model",
      "unsupported model",
      "does not exist",
      "unknown model",
    ])
  ) {
    return {
      kind: "model_not_found",
      raw: raw || summary,
      summary,
      userMessage: buildUserMessage("模型不存在、不可用或已被禁用", detail),
      status,
      retryable: false,
    };
  }

  if (
    status === 502 ||
    status === 503 ||
    status === 504 ||
    hasAnyPattern(lower, ["bad gateway", "gateway timeout", "service unavailable"])
  ) {
    return {
      kind: "gateway_failed",
      raw: raw || summary,
      summary,
      userMessage: buildUserMessage("上游网关异常", detail, "请稍后重试或检查中转服务。"),
      status,
      retryable: true,
    };
  }

  if (
    hasAnyPattern(lower, [
      "econnreset",
      "econnrefused",
      "enotfound",
      "eai_again",
      "network error",
      "fetch failed",
      "socket hang up",
    ])
  ) {
    return {
      kind: "network_failed",
      raw: raw || summary,
      summary,
      userMessage: buildUserMessage("网络连接失败", detail),
      status,
      retryable: true,
    };
  }

  if (typeof status === "number" && status >= 500) {
    return {
      kind: "server_failed",
      raw: raw || summary,
      summary,
      userMessage: buildUserMessage("上游服务异常", detail),
      status,
      retryable: true,
    };
  }

  if (typeof status === "number" && status >= 400) {
    return {
      kind: "request_failed",
      raw: raw || summary,
      summary,
      userMessage: buildUserMessage("请求失败", detail),
      status,
      retryable: false,
    };
  }

  return {
    kind: "unknown",
    raw: raw || summary,
    summary,
    userMessage: buildUserMessage("请求失败", detail || summary),
    status,
    retryable: false,
  };
}

export function summarizeProviderError(
  text: string,
  options?: {
    status?: number;
    fallback?: string;
  },
) {
  const summary = summarizeKnownProviderError(text);
  if (summary) return summary;
  return buildFallbackSummary(options?.status, options?.fallback);
}
