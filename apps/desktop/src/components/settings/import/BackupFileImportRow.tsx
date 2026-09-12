import { Download, HardDrive } from "lucide-react";
import { useCallback, useState } from "react";
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "ui";
import { formatDataTransferLabel, getDataTransferLabel } from "../../../lib/i18n/agent";
import { notifyError, notifySuccess, notifyWarning } from "../../../lib/notify";
import { createServerApi } from "../../../lib/serverApi";
import { isDesktopRuntime } from "../../../lib/tauriBridge";
import type { ImportResult } from "../../../types/chat";

const api = createServerApi();

function getFormatLabel(format: string): string {
  switch (format) {
    case "openhorn":
      return getDataTransferLabel("settings.data.format.openhorn");
    case "chatgpt":
      return getDataTransferLabel("settings.data.format.chatgpt");
    case "claude":
      return getDataTransferLabel("settings.data.format.claude");
    default:
      return getDataTransferLabel("settings.data.format.unknown");
  }
}

/**
 * The always-present "import from a backup / export file" source row shown at
 * the bottom of the import source list, plus its confirm and result dialogs.
 * Covers OpenHorn backups and ChatGPT / Claude export files.
 */
export function BackupFileImportRow({ onImported }: { onImported?: () => void }) {
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [importFilePath, setImportFilePath] = useState<string | null>(null);
  const [detectedFormat, setDetectedFormat] = useState<string | null>(null);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [importResultDialogOpen, setImportResultDialogOpen] = useState(false);

  const handleImport = useCallback(async () => {
    if (!isDesktopRuntime()) {
      notifyWarning(
        getDataTransferLabel("settings.data.notify.cancelled"),
        getDataTransferLabel("settings.data.notify.noTauri"),
      );
      return;
    }

    try {
      const { pickImportFile } = await import("../../../lib/tauriBridge");
      const filePath = await pickImportFile();
      if (!filePath) return;

      setImportFilePath(filePath);
      setDetecting(true);

      const { format } = await api.dataTransfer.detectFormat(filePath);
      setDetectedFormat(format);
      setDetecting(false);

      if (format === "unknown") {
        notifyError(
          getDataTransferLabel("settings.data.import.failedTitle"),
          getFormatLabel("unknown"),
        );
        return;
      }

      setImportDialogOpen(true);
    } catch (err) {
      setDetecting(false);
      notifyError(
        getDataTransferLabel("settings.data.import.failedTitle"),
        err instanceof Error ? err.message : String(err),
      );
    }
  }, []);

  const confirmImport = useCallback(async () => {
    if (!importFilePath || !detectedFormat) return;

    setImporting(true);
    try {
      const result = await api.dataTransfer.importData(importFilePath, detectedFormat);
      setImportResult(result);
      setImportDialogOpen(false);
      setImportResultDialogOpen(true);
      notifySuccess(
        getDataTransferLabel("settings.data.import.successTitle"),
        formatDataTransferLabel("settings.data.import.resultConversations", {
          imported: result.conversations.imported,
          skipped: result.conversations.skipped,
        }),
      );
      onImported?.();
    } catch (err) {
      notifyError(
        getDataTransferLabel("settings.data.import.failedTitle"),
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      setImporting(false);
    }
  }, [importFilePath, detectedFormat, onImported]);

  return (
    <>
      <div className="flex items-center justify-between gap-3 rounded-xl border border-border/50 bg-background/60 p-3">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
            <HardDrive size={18} />
          </div>
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">
              {getDataTransferLabel("settings.data.import.title")}
            </p>
            <p className="truncate text-xs text-muted-foreground">
              {getDataTransferLabel("settings.data.import.description")}
            </p>
          </div>
        </div>
        <Button size="sm" onClick={() => void handleImport()} disabled={detecting || importing}>
          <Download size={16} />{" "}
          {detecting
            ? getDataTransferLabel("settings.data.import.detecting")
            : importing
              ? getDataTransferLabel("settings.data.import.importing")
              : getDataTransferLabel("settings.data.import.button")}
        </Button>
      </div>

      {/* Import confirmation dialog */}
      <Dialog open={importDialogOpen} onOpenChange={setImportDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{getDataTransferLabel("settings.data.import.confirmTitle")}</DialogTitle>
            <DialogDescription>
              {getDataTransferLabel("settings.data.import.confirmBody")}
            </DialogDescription>
          </DialogHeader>

          {detectedFormat ? (
            <div className="py-2 flex items-center gap-2">
              <Badge variant="secondary">{getFormatLabel(detectedFormat)}</Badge>
              <span className="text-sm text-muted-foreground">
                {formatDataTransferLabel("settings.data.import.formatDetected", {
                  format: getFormatLabel(detectedFormat),
                })}
              </span>
            </div>
          ) : null}

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setImportDialogOpen(false)}
              disabled={importing}
            >
              {getDataTransferLabel("settings.data.import.cancel")}
            </Button>
            <Button onClick={confirmImport} disabled={importing}>
              {importing
                ? getDataTransferLabel("settings.data.import.importing")
                : getDataTransferLabel("settings.data.import.confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Import result dialog */}
      <Dialog open={importResultDialogOpen} onOpenChange={setImportResultDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{getDataTransferLabel("settings.data.import.successTitle")}</DialogTitle>
            <DialogDescription>
              {importResult ? getFormatLabel(importResult.format) : null}
            </DialogDescription>
          </DialogHeader>

          {importResult ? (
            <div className="flex flex-col gap-1.5 py-2 text-sm">
              <p>
                {formatDataTransferLabel("settings.data.import.resultConversations", {
                  imported: importResult.conversations.imported,
                  skipped: importResult.conversations.skipped,
                })}
              </p>
              <p>
                {formatDataTransferLabel("settings.data.import.resultMessages", {
                  imported: importResult.messages.imported,
                })}
              </p>
              {importResult.attachments.imported > 0 || importResult.attachments.missing > 0 ? (
                <p>
                  {formatDataTransferLabel("settings.data.import.resultAttachments", {
                    imported: importResult.attachments.imported,
                    missing: importResult.attachments.missing,
                  })}
                </p>
              ) : null}
              {importResult.channels.imported > 0 || importResult.channels.needsKey > 0 ? (
                <p>
                  {formatDataTransferLabel("settings.data.import.resultChannels", {
                    imported: importResult.channels.imported,
                    skipped: importResult.channels.skipped,
                    needsKey: importResult.channels.needsKey,
                  })}
                </p>
              ) : null}
              {importResult.projects.imported > 0 || importResult.projects.needsRebind > 0 ? (
                <p>
                  {formatDataTransferLabel("settings.data.import.resultProjects", {
                    imported: importResult.projects.imported,
                    needsRebind: importResult.projects.needsRebind,
                  })}
                </p>
              ) : null}
              {importResult.mcpServers.imported > 0 || importResult.mcpServers.needsConfirm > 0 ? (
                <p>
                  {formatDataTransferLabel("settings.data.import.resultMcp", {
                    imported: importResult.mcpServers.imported,
                    needsConfirm: importResult.mcpServers.needsConfirm,
                  })}
                </p>
              ) : null}
              {importResult.scheduledTasks.imported > 0 ? (
                <p>
                  {formatDataTransferLabel("settings.data.import.resultScheduledTasks", {
                    imported: importResult.scheduledTasks.imported,
                  })}
                </p>
              ) : null}
              {importResult.errors.length > 0 ? (
                <div className="mt-2 rounded border border-destructive/50 bg-destructive/5 p-2">
                  <p className="text-xs font-medium text-destructive mb-1">
                    {formatDataTransferLabel("settings.data.import.resultErrors", {
                      count: importResult.errors.length,
                    })}
                  </p>
                  {importResult.errors.map((err) => (
                    <p key={err} className="text-xs text-destructive/80">
                      {err}
                    </p>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}

          <DialogFooter>
            <Button onClick={() => setImportResultDialogOpen(false)}>
              {getDataTransferLabel("settings.data.export.cancel")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
