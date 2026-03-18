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

  const withoutTags = normalizeWhitespace(normalized.replace(/<[^>]+>/g, " "));
  if (!withoutTags) return "";

  return clipText(withoutTags);
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

  if (options?.fallback) return options.fallback;
  if (typeof options?.status === "number") return `Request failed (${options.status})`;
  return "Request failed";
}
