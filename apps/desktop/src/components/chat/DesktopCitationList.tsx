import { ChevronDown } from "lucide-react";
import { normalizeExternalUrl } from "../../lib/normalizeExternalUrl";
import type { ApiCitation } from "../../types/chat";

export function DesktopCitationList({
  citations,
}: {
  citations?: ApiCitation[];
  content?: string;
}) {
  if (!citations || citations.length === 0) return null;

  return (
    <details className="group mt-2 w-full min-w-0 max-w-full text-sm">
      <summary className="block w-full cursor-pointer list-none select-none [&::-webkit-details-marker]:hidden">
        <div className="flex min-w-0 items-center gap-1.5 text-sm leading-6 text-foreground/56">
          <span>Sources</span>
          <span className="text-foreground/34">· {citations.length}</span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 transition-transform duration-150 group-open:rotate-180" />
        </div>
      </summary>

      <div className="mt-1.5 flex flex-col gap-1.5">
        {citations.map((citation, index) => (
          <a
            key={`${citation.url}-${index}`}
            href={normalizeExternalUrl(citation.url)}
            rel="noreferrer"
            className="block w-full min-w-0 max-w-full overflow-hidden py-0.5 text-sm leading-6 text-foreground/56 transition-colors hover:text-foreground"
          >
            <div className="flex min-w-0 items-baseline gap-2">
              <span className="shrink-0 text-foreground/30">[{index}]</span>
              <div className="min-w-0 flex-1 break-words text-foreground/70">
                {citation.title || citation.url}
              </div>
            </div>
            <div className="truncate text-foreground/36">{citation.url}</div>
            {citation.snippet && (
              <div className="line-clamp-2 text-foreground/36">{citation.snippet}</div>
            )}
          </a>
        ))}
      </div>
    </details>
  );
}
