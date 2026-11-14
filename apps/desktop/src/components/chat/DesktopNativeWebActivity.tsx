import { ChevronDown } from "lucide-react";
import type { ProviderChatMetadata } from "shared/types";
import { getDeepSeekLabel as label } from "../../lib/i18n/agent";
import { safeWebReference } from "../../lib/webReferences";

export function DesktopNativeWebActivity({ metadata }: { metadata?: ProviderChatMetadata }) {
  if (!metadata?.steps?.length && !metadata?.toolUsage) return null;
  const steps = metadata.steps ?? [];
  const usage = metadata.toolUsage;
  return (
    <details className="group mb-3 rounded-lg border border-border/50 bg-background/60 text-xs">
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded-lg px-3 py-2 text-muted-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
        <span>{label("process")}</span>
        <span className="tabular-nums">{steps.length}</span>
        <ChevronDown
          aria-hidden="true"
          className="ml-auto h-3.5 w-3.5 transition-transform group-open:rotate-180"
        />
      </summary>
      <ol className="space-y-2 border-t border-border/50 px-3 py-3">
        {steps.map((step) => {
          const url = safeWebReference(step.url);
          return (
            <li key={step.id} className="flex min-w-0 items-start gap-3">
              <span className="shrink-0 text-muted-foreground">{step.action}</span>
              <span className="min-w-0 flex-1 break-words">
                {url ? (
                  <a
                    href={url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline decoration-border underline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
                  >
                    {step.title || url}
                  </a>
                ) : (
                  step.query || step.title
                )}
              </span>
              <span className="shrink-0 text-muted-foreground">{step.status}</span>
            </li>
          );
        })}
      </ol>
      {usage && (
        <p className="border-t border-border/50 px-3 py-2 text-muted-foreground">
          {label("toolUsage")
            .replace("{search}", String(usage.search))
            .replace("{fetch}", String(usage.fetch))
            .replace("{imageSearch}", String(usage.imageSearch))}
        </p>
      )}
    </details>
  );
}
