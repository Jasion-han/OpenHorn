import { type ReactNode, useEffect, useRef, useState } from "react";
import type { LibrarySource } from "shared/types";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "ui";
import { getLibraryLabel as label } from "../../lib/i18n/agent";
import { LibraryApiError, libraryApi, libraryError } from "../../lib/libraryApi";
import { exactLibrarySourceRange } from "./LibrarySourceLocation";

type SourceBody = { text: string } | { error: string };

export function LibraryTextSourceDialog({
  source,
  snapshot,
  onClose,
  onCloseAutoFocus,
}: {
  source: LibrarySource;
  snapshot: ReactNode;
  onClose(): void;
  onCloseAutoFocus(event: Event): void;
}) {
  const [body, setBody] = useState<SourceBody | null>(null);
  const highlight = useRef<HTMLElement>(null);
  const text = body && "text" in body ? body.text : "";
  const range = text ? exactLibrarySourceRange(text, source) : null;
  useEffect(() => {
    let active = true;
    void libraryApi.get(source.documentId).then(
      ({ document }) => {
        if (active) setBody({ text: document.text });
      },
      (error: unknown) => {
        if (active)
          setBody({
            error:
              error instanceof LibraryApiError && error.code === "library_not_found"
                ? label("library.errors.sourceOriginalUnavailable")
                : libraryError(error),
          });
      },
    );
    return () => {
      active = false;
    };
  }, [source.documentId]);
  const highlightStart = range?.start;
  useEffect(() => {
    if (highlightStart !== undefined)
      highlight.current?.scrollIntoView({ block: "center", inline: "nearest" });
  }, [highlightStart]);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="flex max-h-[85vh] max-w-[min(46rem,calc(100vw-2rem))] flex-col gap-3 overflow-hidden bg-card"
        onCloseAutoFocus={onCloseAutoFocus}
      >
        <DialogHeader>
          <DialogTitle>{label("library.originalText")}</DialogTitle>
          <DialogDescription className="break-words">{source.fileName}</DialogDescription>
        </DialogHeader>
        {!body ? (
          <output className="text-sm text-muted-foreground">{label("library.loading")}</output>
        ) : (
          <div className="min-h-0 space-y-3 overflow-auto overscroll-contain">
            {!range && (
              <>
                {"error" in body ? (
                  <p role="alert" className="text-sm text-destructive">
                    {body.error}
                  </p>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    {label(
                      !text
                        ? "library.sourceBodyUnavailable"
                        : source.location?.startOffset === undefined
                          ? "library.sourcePositionMissing"
                          : "library.sourcePositionChanged",
                    )}
                  </p>
                )}
                {snapshot}
              </>
            )}
            {text && (
              <pre className="whitespace-pre-wrap break-words rounded-md border border-stone-200 bg-stone-50 p-4 font-sans text-sm leading-7 text-stone-900">
                {range ? (
                  <>
                    {text.slice(0, range.start)}
                    <mark ref={highlight} className="rounded bg-amber-200 text-amber-950">
                      {source.text}
                    </mark>
                    {text.slice(range.end)}
                  </>
                ) : (
                  text
                )}
              </pre>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
