import { useEffect, useRef, useState } from "react";
import { LIBRARY_LIMITS, libraryFileType, libraryScopeKey } from "shared/library";
import type { LibraryFolder, LibraryScope } from "shared/types";
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
import { formatLibraryLabel as format, getLibraryLabel as label } from "../../lib/i18n/agent";
import { useLibraryDraftStore } from "../../stores/libraryDraftStore";
import { DiscardChangesNotice } from "../workbench/DiscardChangesNotice";
import { LibraryFolderPicker } from "./LibraryFolderControls";

const noFiles: File[] = [];

export function LibraryUploadDialog({
  scope,
  scopeName,
  defaultFolderId,
  folders,
  foldersLoading,
  errorMessage,
  owns,
  onClose,
  onUpload,
}: {
  scope: LibraryScope;
  scopeName: string;
  defaultFolderId?: string | null;
  folders: LibraryFolder[];
  foldersLoading: boolean;
  errorMessage: string;
  owns(): boolean;
  onClose(): void;
  onUpload(scope: LibraryScope, file: File, folderId?: string | null): Promise<boolean>;
}) {
  const scopeKey = libraryScopeKey(scope);
  const files = useLibraryDraftStore((state) =>
    state.upload?.scope === scopeKey ? state.upload.files : noFiles,
  );
  const waitingForReceipt = useLibraryDraftStore((state) => state.runningUpload !== null);
  const [destinationId, setDestinationId] = useState(() => {
    const draft = useLibraryDraftStore.getState().upload;
    return draft?.scope === scopeKey ? draft.folderId : defaultFolderId;
  });
  const scopeFolders = folders.filter(
    (folder) => folder.projectId === (scope.kind === "project" ? scope.projectId : null),
  );
  const destinationAvailable =
    destinationId == null || scopeFolders.some((folder) => folder.id === destinationId);

  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [completed, setCompleted] = useState(0),
    [total, setTotal] = useState(0),
    [failedFile, setFailedFile] = useState<File | null>(null),
    [stopping, setStopping] = useState(false),
    [discard, setDiscard] = useState(false);
  const lock = useRef(false);
  const stop = useRef(false);
  const mounted = useRef(false);
  const fileInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const active = () => mounted.current && owns();
  const beginUpload = (files: File[]) => useLibraryDraftStore.getState().beginUpload(files);
  const endUpload = (files: File[]) => useLibraryDraftStore.getState().endUpload(files);
  const updateFiles = (next: File[], folderId = destinationId) => {
    useLibraryDraftStore
      .getState()
      .setUpload(next.length ? { scope: scopeKey, files: next, folderId } : null);
  };
  const acknowledge = (previous: File[], remaining: File[]) => {
    const draft = useLibraryDraftStore.getState();
    // A late receipt can retire its own queued file, but never a newer draft.
    if (draft.upload?.scope === scopeKey && draft.upload.files === previous)
      draft.setUpload(remaining.length ? { ...draft.upload, files: remaining } : null);
  };
  const enqueue = (selected: File[]) => {
    if (!selected.length || useLibraryDraftStore.getState().runningUpload || discard || !active())
      return;
    const valid: File[] = [];
    const invalid: string[] = [];
    for (const file of selected) {
      if (file.size && file.size <= LIBRARY_LIMITS.fileBytes && libraryFileType(file.name))
        valid.push(file);
      else invalid.push(file.name);
    }
    const room = LIBRARY_LIMITS.documents - files.length;
    setError(
      invalid.length
        ? format("library.errors.batchFiles", { files: invalid.join(", ") })
        : valid.length > room
          ? format("library.errors.batchLimit", { count: LIBRARY_LIMITS.documents })
          : "",
    );
    if (valid.length && room > 0) updateFiles([...files, ...valid.slice(0, room)]);
  };
  const close = () => {
    if (lock.current) return;
    if (waitingForReceipt) return onClose();
    if (files.length) setDiscard(true);
    else onClose();
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{label("library.importTitle")}</DialogTitle>
          <DialogDescription>{label("library.importHint")}</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-5"
          onSubmit={async (event) => {
            event.preventDefault();
            if (
              !files.length ||
              !destinationAvailable ||
              lock.current ||
              discard ||
              !active() ||
              !beginUpload(files)
            )
              return;
            lock.current = true;
            stop.current = false;
            setStopping(false);
            setBusy(true);
            setError("");
            setFailedFile(null);
            setCompleted(0);
            setTotal(files.length);
            try {
              let remaining = files;
              while (remaining.length && active() && !stop.current) {
                const [file, ...next] = remaining;
                const accepted = await onUpload(scope, file, destinationId);
                if (!accepted) {
                  if (active()) setFailedFile(file);
                  return;
                }
                acknowledge(remaining, next);
                remaining = next;
                if (active()) setCompleted(files.length - remaining.length);
              }
              if (!remaining.length && active()) onClose();
            } finally {
              endUpload(files);
              lock.current = false;
              if (active()) setBusy(false);
            }
          }}
        >
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-stone-200 bg-stone-50 px-3 py-2.5">
            <p className="min-w-0 break-words text-sm font-medium">{scopeName}</p>
            <LibraryFolderPicker
              folders={scopeFolders}
              value={destinationId ?? null}
              ariaLabel={label("library.importDestinationFolder")}
              menuClassName="z-[110]"
              unavailableLabel={label(
                foldersLoading ? "library.loading" : "library.importDestinationUnavailable",
              )}
              disabled={waitingForReceipt || discard}
              onChange={(folder) => {
                if (
                  folder === undefined ||
                  !active() ||
                  lock.current ||
                  discard ||
                  useLibraryDraftStore.getState().runningUpload
                )
                  return;
                setDestinationId(folder);
                updateFiles(files, folder);
                setFailedFile(null);
              }}
            />
          </div>
          {!destinationAvailable && !foldersLoading && (
            <p role="alert" className="text-sm text-destructive">
              {label("library.errors.importDestination")}
            </p>
          )}
          {/* biome-ignore lint/a11y/noStaticElementInteractions: the file picker is the keyboard equivalent */}
          <div
            className="space-y-2 rounded-md border border-dashed border-input bg-muted/30 p-3"
            onDragOver={(event) => {
              if (!event.dataTransfer.types.includes("Files")) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = waitingForReceipt || discard ? "none" : "copy";
            }}
            onDrop={(event) => {
              if (!event.dataTransfer.types.includes("Files")) return;
              event.preventDefault();
              enqueue(Array.from(event.dataTransfer.files));
            }}
          >
            <Label htmlFor="library-upload-file" className="sr-only">
              {label("library.file")}
            </Label>
            <Input
              ref={fileInput}
              id="library-upload-file"
              type="file"
              multiple
              className="hidden"
              disabled={waitingForReceipt || discard}
              onChange={(event) => {
                const selected = Array.from(event.target.files ?? []);
                event.target.value = "";
                enqueue(selected);
              }}
            />
            <Button
              type="button"
              variant="outline"
              disabled={waitingForReceipt || discard}
              onClick={() => fileInput.current?.click()}
            >
              {label("library.file")}
            </Button>
            <p className="text-xs text-muted-foreground">{label("library.batchDrop")}</p>
          </div>
          {files.length > 0 && total === 0 && (
            <p className="text-xs text-muted-foreground">
              {format("library.batchQueued", { count: files.length })}
            </p>
          )}
          {files.length > 0 && (
            <ul className="max-h-40 divide-y overflow-y-auto">
              {files.map((file, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: stateless rows may contain identical File metadata
                <li key={index} className="flex items-center justify-between gap-2 py-1">
                  <span className="min-w-0 break-all text-sm">{file.name}</span>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={waitingForReceipt || discard}
                    aria-label={format("library.batchRemoveFile", { file: file.name })}
                    onClick={() => {
                      if (file === failedFile) setFailedFile(null);
                      updateFiles(files.filter((_, position) => position !== index));
                    }}
                  >
                    {label("library.batchRemove")}
                  </Button>
                </li>
              ))}
            </ul>
          )}
          {total > 0 && (
            <output className="block text-sm text-muted-foreground">
              {format("library.batchProgress", { completed, total })}
            </output>
          )}
          {waitingForReceipt && !busy && (
            <output className="block text-sm text-muted-foreground">
              {label("library.batchStopping")}
            </output>
          )}
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          {failedFile && (
            <p role="alert" className="text-sm text-destructive">
              {format("library.errors.batchUpload", { file: failedFile.name })} {errorMessage}
            </p>
          )}
          <DiscardChangesNotice
            open={discard}
            onKeep={() => setDiscard(false)}
            onDiscard={() => {
              updateFiles([]);
              onClose();
            }}
          />
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={discard || (busy && stopping)}
              onClick={() => {
                if (lock.current) {
                  stop.current = true;
                  setStopping(true);
                } else close();
              }}
            >
              {label(
                busy
                  ? stopping
                    ? "library.batchStopping"
                    : "library.batchStop"
                  : "library.cancel",
              )}
            </Button>
            <Button
              type="submit"
              className="bg-amber-100 text-amber-950 hover:bg-amber-200 focus-visible:ring-amber-600"
              disabled={!files.length || !destinationAvailable || waitingForReceipt || discard}
            >
              {label(busy ? "library.working" : "library.import")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
