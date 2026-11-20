import { useEffect, useState } from "react";
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
import { formatLibraryLabel as format, getLibraryLabel as label } from "../../lib/i18n/agent";
import { LibraryApiError, libraryApi, libraryError } from "../../lib/libraryApi";

export function LibraryVersionsDialog({
  document,
  onClose,
  onDownload,
  onRestore,
  status,
}: {
  document: LibraryDocument;
  onClose(): void;
  onDownload(version: LibraryDocument): Promise<void>;
  onRestore(version: LibraryDocument): Promise<void>;
  status(version: LibraryDocument): string;
}) {
  const [versions, setVersions] = useState<LibraryDocument[]>([]),
    [loading, setLoading] = useState(true),
    [busyId, setBusyId] = useState(""),
    [confirmingId, setConfirmingId] = useState(""),
    [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    setLoading(true);
    void libraryApi
      .versions(document.id)
      .then(({ versions: rows }) => {
        if (active) setVersions(rows);
      })
      .catch((reason) => {
        if (active)
          setError(
            libraryError(
              reason instanceof LibraryApiError
                ? reason
                : new LibraryApiError("library_unavailable"),
            ),
          );
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [document.id]);
  const close = () => {
    if (!busyId) onClose();
  };
  return (
    <Dialog open onOpenChange={(open) => !open && close()}>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{label("library.versions")}</DialogTitle>
          <DialogDescription>{document.fileName}</DialogDescription>
        </DialogHeader>
        {error ? (
          <div role="alert" className="space-y-3 py-5 text-sm text-destructive">
            <p>{error}</p>
            <Button variant="outline" size="sm" onClick={() => setError("")}>
              {label("library.close")}
            </Button>
          </div>
        ) : loading ? (
          <p className="py-6 text-sm text-muted-foreground">{label("library.loading")}</p>
        ) : (
          <div className="space-y-2">
            {versions.map((version) => {
              const confirming = confirmingId === version.id;
              return (
                <div
                  key={version.id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3"
                >
                  <div className="min-w-0 space-y-1">
                    <p className="text-sm font-medium">
                      {format("library.version", { number: version.version })}
                      {version.isCurrent && (
                        <span className="ml-2 text-xs font-normal text-muted-foreground">
                          {label("library.currentVersion")}
                        </span>
                      )}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {status(version)} · {Math.ceil(version.fileSize / 1024)} KB ·{" "}
                      {version.updatedAt}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={!!busyId}
                      onClick={async () => {
                        setBusyId(version.id);
                        setError("");
                        try {
                          await onDownload(version);
                        } catch (reason) {
                          setError(
                            libraryError(
                              reason instanceof LibraryApiError
                                ? reason
                                : new LibraryApiError("library_unavailable"),
                            ),
                          );
                        } finally {
                          setBusyId("");
                        }
                      }}
                    >
                      {label("library.download")}
                    </Button>
                    {version.isCurrent ? null : confirming ? (
                      <>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={!!busyId}
                          onClick={() => setConfirmingId("")}
                        >
                          {label("library.restoreCancel")}
                        </Button>
                        <Button
                          size="sm"
                          disabled={!!busyId}
                          onClick={async () => {
                            setBusyId(version.id);
                            setError("");
                            try {
                              await onRestore(version);
                            } catch (reason) {
                              setError(
                                libraryError(
                                  reason instanceof LibraryApiError
                                    ? reason
                                    : new LibraryApiError("library_unavailable"),
                                ),
                              );
                            } finally {
                              setBusyId("");
                              setConfirmingId("");
                            }
                          }}
                        >
                          {label("library.restoreConfirm")}
                        </Button>
                      </>
                    ) : (
                      <Button
                        size="sm"
                        disabled={!!busyId}
                        onClick={() => setConfirmingId(version.id)}
                      >
                        {label("library.restoreVersion")}
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" disabled={!!busyId} onClick={close}>
            {label("library.close")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
