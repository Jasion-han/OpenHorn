import { useRef, useState } from "react";
import { LIBRARY_LIMITS, libraryFileType, libraryScopeKey } from "shared/library";
import type { LibraryScope } from "shared/types";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
} from "ui";
import { getLibraryLabel as label } from "../../lib/i18n/agent";
import { LibraryApiError, libraryError } from "../../lib/libraryApi";
import { useLibraryDraftStore } from "../../stores/libraryDraftStore";
import { DiscardChangesNotice } from "../workbench/DiscardChangesNotice";
export function LibraryUploadDialog({
  scope,
  scopeName,
  errorMessage,
  onClose,
  onUpload,
}: {
  scope: LibraryScope;
  scopeName: string;
  errorMessage: string;
  onClose(): void;
  onUpload(scope: LibraryScope, file: File): Promise<boolean>;
}) {
  const [file, setFile] = useState<File | null>(() => {
      const draft = useLibraryDraftStore.getState().upload;
      return draft?.scope === libraryScopeKey(scope) ? draft.file : null;
    }),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [discard, setDiscard] = useState(false);
  const lock = useRef(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const close = () => {
    if (lock.current) return;
    if (file) setDiscard(true);
    else onClose();
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{label("library.importTitle")}</DialogTitle>
          <DialogDescription>{label("library.importHint")}</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-5"
          onSubmit={async (event) => {
            event.preventDefault();
            if (!file || lock.current || discard) return;
            lock.current = true;
            setBusy(true);
            try {
              if (await onUpload(scope, file)) {
                useLibraryDraftStore.getState().setUpload(null);
                onClose();
              }
            } finally {
              lock.current = false;
              setBusy(false);
            }
          }}
        >
          <p className="text-sm text-muted-foreground">
            {label("library.destination")} · {scopeName}
          </p>
          <div className="space-y-2">
            <Label htmlFor="library-upload-file" className="sr-only">
              {label("library.file")}
            </Label>
            <Input
              ref={fileInput}
              id="library-upload-file"
              type="file"
              className="hidden"
              disabled={busy || discard}
              onChange={(event) => {
                const next = event.target.files?.[0] ?? null;
                // The File draft owns the selection, including after navigation.
                // Canceling the system picker must not discard an existing File.
                event.target.value = "";
                if (!next) return;
                setError("");
                if (
                  next &&
                  (!next.size ||
                    next.size > LIBRARY_LIMITS.fileBytes ||
                    !libraryFileType(next.name))
                ) {
                  setError(
                    libraryError(
                      new LibraryApiError(
                        !next.size || next.size > LIBRARY_LIMITS.fileBytes
                          ? "library_file_limit"
                          : "library_unsupported_file",
                      ),
                    ),
                  );
                  setFile(null);
                  useLibraryDraftStore.getState().setUpload(null);
                  return;
                }
                setFile(next);
                useLibraryDraftStore
                  .getState()
                  .setUpload(next ? { scope: libraryScopeKey(scope), file: next } : null);
              }}
            />
            <Button
              type="button"
              variant="outline"
              disabled={busy || discard}
              onClick={() => fileInput.current?.click()}
            >
              {label("library.file")}
            </Button>
            {file && (
              <p className="break-all text-xs text-muted-foreground">
                {file.name} · {Math.ceil(file.size / 1024)} KB
              </p>
            )}
          </div>
          <p className="text-xs text-muted-foreground">{label("library.ocr.localHint")}</p>
          {(error || errorMessage) && (
            <p role="alert" className="text-sm text-destructive">
              {error || errorMessage}
            </p>
          )}
          <DiscardChangesNotice
            open={discard}
            onKeep={() => setDiscard(false)}
            onDiscard={() => {
              useLibraryDraftStore.getState().setUpload(null);
              onClose();
            }}
          />
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy || discard} onClick={close}>
              {label("library.cancel")}
            </Button>
            <Button type="submit" disabled={!file || busy || discard}>
              {label(busy ? "library.working" : "library.import")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
