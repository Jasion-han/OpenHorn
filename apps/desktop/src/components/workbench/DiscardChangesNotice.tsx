import { useEffect, useRef } from "react";
import { Button } from "ui";
import { getWorkbenchLabel as label } from "../../lib/i18n/agent";

/** Confirm within the existing form instead of opening a second modal. */
export function DiscardChangesNotice({
  open,
  onKeep,
  onDiscard,
}: {
  open: boolean;
  onKeep(): void;
  onDiscard(): void;
}) {
  const keep = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const container = keep.current?.closest('[role="dialog"], section');
    keep.current?.focus();
    return () => {
      if (previous?.isConnected) previous.focus();
      else if (container?.isConnected)
        container
          .querySelector<HTMLElement>(
            "input:not(:disabled), textarea:not(:disabled), select:not(:disabled)",
          )
          ?.focus();
    };
  }, [open]);
  if (!open) return null;
  return (
    <div
      role="alert"
      aria-label={label("workbench.edit.discardTitle")}
      className="w-full space-y-3 border-t pt-4"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onKeep();
        }
      }}
    >
      <p className="text-sm font-medium">{label("workbench.edit.discardTitle")}</p>
      <p className="text-xs text-muted-foreground">{label("workbench.edit.discardHint")}</p>
      <div className="flex flex-wrap justify-end gap-2">
        <Button ref={keep} type="button" variant="outline" onClick={onKeep}>
          {label("workbench.edit.keep")}
        </Button>
        <Button type="button" variant="destructive" onClick={onDiscard}>
          {label("workbench.edit.discard")}
        </Button>
      </div>
    </div>
  );
}
