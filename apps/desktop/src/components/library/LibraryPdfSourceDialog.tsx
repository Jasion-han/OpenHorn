import { lazy, type ReactNode, Suspense, useCallback, useEffect, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "ui";
import { getLibraryLabel as label } from "../../lib/i18n/agent";
import { LibraryApiError, libraryApi, libraryError } from "../../lib/libraryApi";

const PdfPreview = lazy(() =>
  import("../chat/DesktopAttachmentPdf").then((module) => ({
    default: module.DesktopAttachmentPdf,
  })),
);

export type LibraryPdfSource = { documentId: string; fileName: string; page?: number };

export function LibraryPdfSourceDialog({
  source,
  onClose,
  onCloseAutoFocus,
  snapshot,
}: {
  source: LibraryPdfSource;
  onClose(): void;
  onCloseAutoFocus?(event: Event): void;
  snapshot?: ReactNode;
}) {
  const hasSnapshot = Boolean(snapshot);
  const [blob, setBlob] = useState<Blob | null>(null);
  const [error, setError] = useState("");
  const onError = useCallback(() => setError(label("library.pdfPreviewFailed")), []);
  useEffect(() => {
    let active = true;
    void libraryApi.original(source.documentId).then(
      (original) => {
        if (active) setBlob(original);
      },
      (error: unknown) => {
        if (active)
          setError(
            hasSnapshot && error instanceof LibraryApiError && error.code === "library_not_found"
              ? label("library.errors.sourceOriginalUnavailable")
              : libraryError(error),
          );
      },
    );
    return () => {
      active = false;
    };
  }, [source.documentId, hasSnapshot]);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        className="flex h-[85vh] max-w-[min(50rem,calc(100vw-2rem))] flex-col gap-3 overflow-hidden bg-card"
        onCloseAutoFocus={onCloseAutoFocus}
      >
        <DialogHeader>
          <DialogTitle>{label("library.pdfPreview")}</DialogTitle>
          <DialogDescription className="break-all">{source.fileName}</DialogDescription>
        </DialogHeader>
        {error ? (
          <div className="space-y-3 overflow-auto">
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
            {snapshot}
          </div>
        ) : (
          <Suspense fallback={<output>{label("library.loading")}</output>}>
            {blob ? (
              <PdfPreview blob={blob} initialPage={source.page} onError={onError} />
            ) : (
              <output>{label("library.loading")}</output>
            )}
          </Suspense>
        )}
      </DialogContent>
    </Dialog>
  );
}
