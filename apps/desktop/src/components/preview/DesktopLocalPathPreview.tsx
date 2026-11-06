import { Copy, ExternalLink, FolderOpen, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "ui";
import { attachmentKind, canOpenAttachment, previewMediaType } from "../../lib/attachmentPreview";
import { getPreviewLabel } from "../../lib/i18n/agent";
import { localPathErrorLabel } from "../../lib/localPathReference";
import {
  inspectLocalPath,
  type LocalPathInfo,
  openLocalPath,
  readLocalPath,
  revealLocalPath,
} from "../../lib/tauriBridge";
import { type PreviewTab, usePreviewPanelStore } from "../../stores/previewPanelStore";
import { DesktopAttachmentViewer } from "../chat/DesktopAttachmentViewer";

type LocalTab = Extract<PreviewTab, { kind: "local" }>;
const buttonClass =
  "inline-flex size-8 items-center justify-center rounded hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
export function DesktopLocalPathPreview({ tab, narrow }: { tab: LocalTab; narrow: boolean }) {
  const [state, setState] = useState<{ info: LocalPathInfo; file?: File } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let alive = true;
    void reload;
    // A fresh click on an existing tab rechecks the real filesystem.
    void tab.revision;
    setState(null);
    setError(null);
    void (async () => {
      const info = await inspectLocalPath(tab.path);
      if (!alive) return;
      if (info.kind === "directory") {
        await openLocalPath(tab.path);
        if (alive) usePreviewPanelStore.getState().closeTab(tab.id);
        return;
      }
      if (info.size > 20 * 1024 * 1024) {
        setState({ info });
        return;
      }
      const bytes = await readLocalPath(tab.path);
      if (!alive) return;
      const kind = attachmentKind({ fileName: info.fileName });
      const file = new File([new Uint8Array(bytes)], info.fileName, {
        type:
          kind === "text"
            ? "text/plain"
            : kind === "markdown"
              ? "text/markdown"
              : previewMediaType({ fileName: info.fileName }, ""),
      });
      setState({ info, file });
    })().catch((reason) => {
      if (alive) setError(localPathErrorLabel(reason));
    });
    return () => {
      alive = false;
    };
  }, [tab.path, tab.id, tab.revision, reload]);
  const attachments = useMemo(
    () =>
      state?.file
        ? [{ fileName: state.info.fileName, fileSize: state.info.size, fileType: state.file.type }]
        : [],
    [state],
  );
  const action = (kind: "open" | "reveal" | "copy") => {
    const task =
      kind === "open"
        ? openLocalPath(tab.path)
        : kind === "reveal"
          ? revealLocalPath(tab.path)
          : navigator.clipboard.writeText(tab.path);
    void task.catch((reason) => setError(localPathErrorLabel(reason)));
  };
  const content = (
    <div className="flex h-full min-h-0 flex-col">
      <div
        className={`flex shrink-0 items-center gap-1 border-b px-3 py-2 ${narrow ? "pr-12" : ""}`}
      >
        <span className="min-w-0 flex-1 truncate font-mono text-xs" title={tab.path}>
          {tab.path}
        </span>
        <button
          type="button"
          className={buttonClass}
          title={getPreviewLabel("preview.local.copyPath")}
          aria-label={getPreviewLabel("preview.local.copyPath")}
          onClick={() => action("copy")}
        >
          <Copy aria-hidden="true" className="size-4" />
        </button>
        <button
          type="button"
          className={buttonClass}
          title={getPreviewLabel("preview.file.menu.reveal")}
          aria-label={getPreviewLabel("preview.file.menu.reveal")}
          onClick={() => action("reveal")}
        >
          <FolderOpen aria-hidden="true" className="size-4" />
        </button>
        <button
          type="button"
          className={buttonClass}
          title={getPreviewLabel("preview.file.reload")}
          aria-label={getPreviewLabel("preview.file.reload")}
          onClick={() => setReload((n) => n + 1)}
        >
          <RefreshCw aria-hidden="true" className="size-4" />
        </button>
      </div>
      {error ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
          <p role="alert" className="text-sm text-muted-foreground">
            {error}
          </p>
          <button
            type="button"
            className="rounded px-3 py-2 text-sm hover:bg-muted"
            onClick={() => setReload((n) => n + 1)}
          >
            {getPreviewLabel("preview.file.retry")}
          </button>
        </div>
      ) : !state ? (
        <output className="p-5 text-sm text-muted-foreground">
          {getPreviewLabel("preview.file.loading")}
        </output>
      ) : state.file ? (
        <DesktopAttachmentViewer
          attachments={attachments}
          index={0}
          file={state.file}
          presentation="panel"
          allowExpand={!narrow}
          closeLabel={getPreviewLabel("preview.local.close")}
          allowExport={false}
          onOpenExternal={
            canOpenAttachment(state.info.fileName)
              ? () =>
                  openLocalPath(tab.path).catch((reason) => setError(localPathErrorLabel(reason)))
              : undefined
          }
          onClose={() => usePreviewPanelStore.getState().closeTab(tab.id)}
        />
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-4 p-6 text-center">
          <p className="text-sm text-muted-foreground">
            {getPreviewLabel("preview.local.largeFile")}
          </p>
          {canOpenAttachment(state.info.fileName) && (
            <button
              type="button"
              className="inline-flex items-center gap-2 rounded px-3 py-2 hover:bg-muted"
              onClick={() => action("open")}
            >
              <ExternalLink aria-hidden="true" className="size-4" />
              {getPreviewLabel("preview.file.openWithDefault")}
            </button>
          )}
        </div>
      )}
    </div>
  );
  if (!narrow) return content;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) usePreviewPanelStore.getState().closeTab(tab.id);
      }}
    >
      <DialogContent className="flex h-[min(820px,90vh)] w-[94vw] max-w-5xl flex-col gap-0 overflow-hidden p-0">
        <DialogTitle className="sr-only">{tab.path}</DialogTitle>
        <DialogDescription className="sr-only">
          {getPreviewLabel("preview.local.description")}
        </DialogDescription>
        {content}
      </DialogContent>
    </Dialog>
  );
}
