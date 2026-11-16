import { useEffect, useRef, useState } from "react";
import type { ToolServiceStatus } from "shared/tool-connection";
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
import { createServerApi } from "../../lib/serverApi";

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
  onConfirm(connectionToken?: string): Promise<boolean>;
}) {
  const [consent, setConsent] = useState(false),
    [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [service, setService] = useState<ToolServiceStatus | null>(null);
  const [serviceError, setServiceError] = useState(false);
  const [reload, setReload] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: explicit retry reruns the same status request
  useEffect(() => {
    let active = true;
    setService(null);
    setServiceError(false);
    setConsent(false);
    void createServerApi()
      .settings.toolStatus()
      .then((value) => {
        if (active) setService(value);
      })
      .catch(() => {
        if (active) setServiceError(true);
      });
    return () => {
      active = false;
    };
  }, [reload]);
  const available =
    service?.configured &&
    service.connectionToken &&
    (service.kind !== "openrouter" || document.fileType === "application/pdf");
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
            if (!consent || lock.current || !available) return;
            lock.current = true;
            setBusy(true);
            try {
              if (await onConfirm(service?.connectionToken)) onClose();
            } finally {
              lock.current = false;
              setBusy(false);
            }
          }}
        >
          <p className="break-all text-sm font-medium">{document.fileName}</p>
          {serviceError ? (
            <div role="alert" className="text-sm text-destructive">
              {label("library.ocr.serviceError")}{" "}
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setReload((value) => value + 1)}
              >
                {label("library.retry")}
              </Button>
            </div>
          ) : service === null ? (
            <output className="block text-sm text-muted-foreground">
              {label("library.ocr.serviceLoading")}
            </output>
          ) : (
            <div className="space-y-2 text-sm">
              <p className="break-all">
                {label("library.ocr.serviceDestination")} ·{" "}
                {service.endpoint ?? label("library.ocr.serviceMissing")}
              </p>
              {service.kind === "openrouter" && (
                <p className="text-muted-foreground">{label("library.ocr.routerHint")}</p>
              )}
            </div>
          )}
          <label className="flex cursor-pointer items-start gap-3 rounded-md border border-border bg-muted/50 p-3 text-sm leading-6">
            <input
              type="checkbox"
              checked={consent}
              disabled={busy || !available}
              onChange={(event) => setConsent(event.target.checked)}
              className="mt-1 size-4 shrink-0 accent-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            />
            <span>{label("library.ocr.consent")}</span>
          </label>
          {errorMessage && (
            <p role="alert" className="text-sm text-destructive">
              {errorMessage}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={close}>
              {label("library.cancel")}
            </Button>
            <Button type="submit" disabled={!consent || busy || !available}>
              {label(busy ? "library.ocr.working" : "library.ocr.confirm")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
