import { useCallback, useRef, useState } from "react";
import type { LibrarySource } from "shared/types";
import { getLibraryLabel as label } from "../../lib/i18n/agent";
import { LibraryPdfSourceDialog } from "./LibraryPdfSourceDialog";
import { LibraryTextSourceDialog } from "./LibraryTextSourceDialog";

export function useLibrarySourcePreview() {
  const [preview, setPreview] = useState<LibrarySource | null>(null);
  const previewTrigger = useRef<HTMLButtonElement | null>(null);
  const close = () => setPreview(null);
  const restoreFocus = (event: Event) => {
    if (!previewTrigger.current?.isConnected) return;
    event.preventDefault();
    previewTrigger.current.focus();
  };
  const snapshot = preview && (
    <section className="space-y-1 rounded-md border border-amber-200 bg-amber-50 p-3 text-amber-950">
      <h3 className="text-sm font-medium">{label("library.sourceSnapshot")}</h3>
      <p className="whitespace-pre-wrap break-words text-sm leading-6">{preview.text}</p>
    </section>
  );
  const open = useCallback((source: LibrarySource, trigger: HTMLButtonElement) => {
    previewTrigger.current = trigger;
    setPreview(source);
  }, []);
  const dialog =
    preview &&
    (/\.pdf$/iu.test(preview.fileName) ? (
      <LibraryPdfSourceDialog
        source={{
          documentId: preview.documentId,
          fileName: preview.fileName,
          page: preview.location?.pageStart,
        }}
        snapshot={snapshot}
        onClose={close}
        onCloseAutoFocus={restoreFocus}
      />
    ) : (
      <LibraryTextSourceDialog
        source={preview}
        snapshot={snapshot}
        onClose={close}
        onCloseAutoFocus={restoreFocus}
      />
    ));
  return { open, dialog };
}
