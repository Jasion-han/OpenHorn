import { useRef, useState } from "react";
import type { LibraryDocument } from "shared/types";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "ui";
import { getLibraryLabel as label } from "../../lib/i18n/agent";

/** Consent belongs to one mounted document dialog and is never persisted or reused. */
export function LibraryOcrDialog({
  document,
  errorMessage,
  onClose,
  onConfirm,
}: {
  document: LibraryDocument;
  errorMessage: string;
  onClose(): void;
  onConfirm(): Promise<boolean>;
}) {
  const [consent, setConsent] = useState(false),
    [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const close = () => {
    if (!lock.current) onClose();
  };
  // Missing dictionary entries must never leave an unlabeled paid action available.
  if (
    !label("library.ocr.title") ||
    !label("library.ocr.description") ||
    !label("library.ocr.consent") ||
    !label("library.ocr.confirm")
  )
    return null;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent className="max-w-lg bg-card text-foreground">
        <DialogHeader>
          <DialogTitle>{label("library.ocr.title")}</DialogTitle>
          <DialogDescription>{label("library.ocr.description")}</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-5"
          onSubmit={async (event) => {
            event.preventDefault();
            if (!consent || lock.current) return;
            lock.current = true;
            setBusy(true);
            try {
              if (await onConfirm()) onClose();
            } finally {
              lock.current = false;
              setBusy(false);
            }
          }}
        >
          <p className="break-all text-sm font-medium">{document.fileName}</p>
          <label className="flex cursor-pointer items-start gap-3 rounded-md border border-border bg-muted/50 p-3 text-sm leading-6">
            <input
              type="checkbox"
              checked={consent}
              disabled={busy}
              onChange={(event) => setConsent(event.target.checked)}
              className="mt-1 size-4 shrink-0 accent-amber-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-300"
            />
            <span>{label("library.ocr.consent")}</span>
          </label>
          {errorMessage && (
            <p role="alert" className="text-sm text-destructive">
              {errorMessage}
            </p>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={close}
              className="focus-visible:ring-amber-300"
            >
              {label("library.cancel")}
            </Button>
            <Button
              type="submit"
              variant="secondary"
              disabled={!consent || busy}
              className="bg-amber-100 text-foreground hover:bg-amber-200 focus-visible:ring-amber-300"
            >
              {label(busy ? "library.ocr.working" : "library.ocr.confirm")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
