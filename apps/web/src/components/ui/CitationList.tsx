"use client";

import { ChevronDown } from "lucide-react";
import { useState } from "react";
import type { ApiCitation } from "@/lib/api";
import { extractUsedCitationIndices } from "@/lib/citations";
import { normalizeExternalUrl } from "@/lib/normalizeExternalUrl";
import { CitationBadge } from "./CitationReference";

export function CitationList({
  citations,
  content,
}: {
  citations?: ApiCitation[];
  content?: string;
}) {
  const [showAll, setShowAll] = useState(false);
  if (!citations || citations.length === 0) return null;

  const used = content ? extractUsedCitationIndices(content, citations.length) : [];
  const effectiveShowAll = used.length === 0 ? true : showAll;

  const displayed = effectiveShowAll
    ? citations.map((citation, index) => ({ citation, index: index + 1 }))
    : used
        .map((index) => ({ citation: citations[index - 1], index }))
        .filter(
          (entry): entry is { citation: ApiCitation; index: number } =>
            entry.citation !== undefined,
        );

  const usedCount = used.length > 0 ? used.length : citations.length;

  return (
    <details className="group mb-2 w-full min-w-0 max-w-full rounded-xl border border-border/50 bg-muted/20 px-3 py-2 text-sm">
      <summary className="block w-full cursor-pointer list-none select-none [&::-webkit-details-marker]:hidden">
        <div className="flex min-w-0 items-center justify-between gap-3">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Sources
            </span>
            <span className="shrink-0 text-[11px] text-muted-foreground/80">
              · {usedCount}/{citations.length}
            </span>
          </div>
          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-150 group-open:rotate-180" />
        </div>
      </summary>

      <div className="mt-2 flex flex-col gap-1.5">
        <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 gap-y-1 pb-1">
          <p className="min-w-0 text-[11px] text-muted-foreground">
            {used.length === 0
              ? "本轮未在正文标注引用，展示全部来源。"
              : effectiveShowAll
                ? "展示全部来源。"
                : "仅展示已引用来源。"}
          </p>
          {used.length > 0 && (
            <button
              type="button"
              className="justify-self-end whitespace-nowrap rounded-md border border-border/50 bg-background/50 px-2 py-1 text-left text-[11px] text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
              onClick={() => setShowAll((prev) => !prev)}
            >
              {effectiveShowAll ? "Show used only" : "Show all"}
            </button>
          )}
        </div>

        {displayed.map(({ citation, index }) => (
          <a
            key={`${citation.url}-${index}`}
            href={normalizeExternalUrl(citation.url)}
            target="_blank"
            rel="noreferrer"
            className="block w-full min-w-0 max-w-full overflow-hidden rounded-md border border-border/40 bg-background/70 px-2 py-1.5 text-xs transition-colors hover:bg-background"
          >
            <div className="flex min-w-0 items-baseline gap-2">
              <CitationBadge index={index} className="shrink-0" />
              <div className="min-w-0 flex-1 break-words font-medium text-foreground">
                {citation.title}
              </div>
            </div>
            <div className="truncate text-muted-foreground">{citation.url}</div>
            {citation.snippet && (
              <div className="mt-0.5 line-clamp-2 text-muted-foreground">{citation.snippet}</div>
            )}
          </a>
        ))}
      </div>
    </details>
  );
}
