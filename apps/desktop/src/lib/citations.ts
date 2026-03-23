import type { ApiCitation } from "../types/chat";

function buildCitationTitleFromUrl(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./i, "");
  } catch {
    return url;
  }
}

export function extractUsedCitationIndices(content: string, maxIndex: number) {
  const used = new Set<number>();
  const re = /\[(\d+)\]/g;
  for (const match of content.matchAll(re)) {
    const n = Number.parseInt(match[1] || "", 10);
    if (!Number.isFinite(n)) continue;
    if (n < 1 || n > maxIndex) continue;
    used.add(n);
  }
  return Array.from(used).sort((a, b) => a - b);
}

export function extractLegacyAppendixCitations(content: string) {
  const normalized = (content || "").replace(/\r\n/g, "\n");
  const matches = Array.from(
    normalized.matchAll(/^\s*\[(\d+)\]\s+(https?:\/\/\S+)(?:\s+[-:]\s+(.+))?\s*$/gm),
  );
  if (matches.length === 0) return undefined;

  const citations = matches
    .sort((left, right) => Number(left[1]) - Number(right[1]))
    .map((match) => ({
      title: (match[3] || "").trim() || buildCitationTitleFromUrl(match[2] || ""),
      url: (match[2] || "").trim(),
    }))
    .filter((citation) => citation.title && citation.url);

  return citations.length > 0 ? citations : undefined;
}

export function stripTrailingCitationAppendix(content: string, citations?: ApiCitation[]) {
  const normalized = (content || "").replace(/\r\n/g, "\n");
  if (!normalized.trim() || !citations || citations.length === 0) return normalized;

  const appendixMatch =
    normalized.match(
      /(?:^|\n)(?:引用|参考资料|参考来源|参考文献|References?|Sources?)[:：]?\s*\n[\s\S]*$/i,
    ) ?? normalized.match(/(?:^|\n)(?:\s*\[\d+\]\s+\S.*(?:\n|$)\s*)+$/);
  if (!appendixMatch || appendixMatch.index == null) return normalized;

  const appendix = appendixMatch[0];
  const refMatches = appendix.match(/\[\d+\]/g) || [];
  if (refMatches.length === 0) return normalized;

  const sourceHits = citations.filter((citation) => {
    const title = citation.title?.trim();
    const url = citation.url?.trim();
    return (title && appendix.includes(title)) || (url && appendix.includes(url));
  }).length;
  if (sourceHits === 0) return normalized;

  return normalized.slice(0, appendixMatch.index).replace(/\s+$/, "");
}

export function sanitizeDisplayContent(content: string, citations?: ApiCitation[]) {
  const withoutAppendix = stripTrailingCitationAppendix(content, citations);
  return withoutAppendix.replace(/\n{3,}/g, "\n\n").trimEnd();
}
