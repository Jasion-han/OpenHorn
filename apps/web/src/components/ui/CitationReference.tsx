"use client";

import type { ReactNode } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { ApiCitation } from "@/lib/api";
import { normalizeExternalUrl } from "@/lib/normalizeExternalUrl";
import { cn } from "@/lib/utils";

const citationBadgeClassName =
  "inline-flex items-center rounded-md border border-border/50 bg-background/80 px-1.5 py-0.5 text-[10px] font-medium leading-none text-muted-foreground shadow-sm transition-colors";

export function CitationBadge({ index, className }: { index: number; className?: string }) {
  return <span className={cn(citationBadgeClassName, className)}>[{index}]</span>;
}

export function CitationHoverCard({ citation }: { citation: ApiCitation }) {
  const normalizedUrl = normalizeExternalUrl(citation.url);
  const domain =
    normalizedUrl === "#"
      ? citation.url
      : (() => {
          try {
            return new URL(normalizedUrl).hostname.replace(/^www\./i, "");
          } catch {
            return citation.url;
          }
        })();

  return (
    <div className="max-w-[14rem] space-y-1">
      <div className="truncate font-medium leading-5 text-foreground">{citation.title}</div>
      <div className="text-[11px] text-muted-foreground">{domain}</div>
    </div>
  );
}

export function InlineCitationReference({
  index,
  citation,
  children,
}: {
  index: number;
  citation: ApiCitation;
  children?: ReactNode;
}) {
  const href = normalizeExternalUrl(citation.url);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          className="mx-0.5 inline-flex align-[0.08em] no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 [&>span]:hover:border-border [&>span]:hover:bg-background [&>span]:hover:text-foreground"
          aria-label={`查看来源 ${index}: ${citation.title}`}
        >
          {children ?? <CitationBadge index={index} className="shrink-0" />}
        </a>
      </TooltipTrigger>
      <TooltipContent
        side="top"
        align="start"
        className="border border-border/60 bg-background px-3 py-2 text-xs text-foreground shadow-xl"
      >
        <CitationHoverCard citation={citation} />
      </TooltipContent>
    </Tooltip>
  );
}
