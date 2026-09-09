import { Download, FileUp, Upload } from "lucide-react";
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
  SettingsCard,
  SettingsSection,
} from "ui";
import { formatDataTransferLabel, getDataTransferLabel } from "../../lib/i18n/agent";
import { notifyError, notifySuccess, notifyWarning } from "../../lib/notify";
import { createServerApi } from "../../lib/serverApi";
import { isDesktopRuntime } from "../../lib/tauriBridge";
import type { ExportEstimate, ImportResult } from "../../types/chat";

const api = createServerApi();

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

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

export function DataTransferSettings() {
  // Export state
  const [estimating, setEstimating] = useState(false);
  const [estimate, setEstimate] = useState<ExportEstimate | null>(null);
  const [exportDialogOpen, setExportDialogOpen] = useState(false);
  const [exportType, setExportType] = useState<"backup" | "dti">("backup");
  const [exporting, setExporting] = useState(false);

  // Import state
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [importFilePath, setImportFilePath] = useState<string | null>(null);
  const [detectedFormat, setDetectedFormat] = useState<string | null>(null);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [importResultDialogOpen, setImportResultDialogOpen] = useState(false);

  const handleExportBackup = useCallback(async () => {
    setEstimating(true);
    try {
      const est = await api.dataTransfer.estimateExport();
      setEstimate(est);
      setExportType("backup");
      setExportDialogOpen(true);
    } catch (err) {
      notifyError(
        getDataTransferLabel("settings.data.export.failedTitle"),
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      setEstimating(false);
    }
  }, []);

  const handleExportDTI = useCallback(async () => {
    setEstimating(true);
    try {
      const est = await api.dataTransfer.estimateExport();
      setEstimate(est);
      setExportType("dti");
      setExportDialogOpen(true);
    } catch (err) {
      notifyError(
        getDataTransferLabel("settings.data.export.failedTitle"),
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      setEstimating(false);
    }
  }, []);

  const confirmExport = useCallback(async () => {
    if (!isDesktopRuntime()) {
      notifyWarning(
        getDataTransferLabel("settings.data.notify.cancelled"),
        getDataTransferLabel("settings.data.notify.noTauri"),
      );
      return;
    }

    setExporting(true);
    try {
      const { pickExportDir } = await import("../../lib/tauriBridge");
      const dir = await pickExportDir();
      if (!dir) {
        setExportDialogOpen(false);
        setExporting(false);
        return;
      }

      if (exportType === "backup") {
        const result = await api.dataTransfer.exportBackup(dir);
        setExportDialogOpen(false);
        notifySuccess(
          getDataTransferLabel("settings.data.export.successTitle"),
          formatDataTransferLabel("settings.data.export.successBody", {
            path: result.filePath,
          }),
        );
      } else {
        const data = await api.dataTransfer.exportDTI();
        // Write the DTI JSON to the chosen directory via the server's backup
        // endpoint is not suitable here — instead we write it locally. Since
        // DTI export returns JSON data, we send it back to the server for
        // file writing by using the backup endpoint with the dir.
        // Actually, the DTI data is already fetched. We need to save it.
        // Use a Blob download approach as a fallback.
        const jsonStr = JSON.stringify(data, null, 2);
        const blob = new Blob([jsonStr], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `openhorn-conversations-${new Date().toISOString().slice(0, 10)}.json`;
        a.click();
        URL.revokeObjectURL(url);

        setExportDialogOpen(false);
        notifySuccess(
          getDataTransferLabel("settings.data.export.successTitle"),
          formatDataTransferLabel("settings.data.export.successBody", {
            path: a.download,
          }),
        );
      }
    } catch (err) {
      notifyError(
        getDataTransferLabel("settings.data.export.failedTitle"),
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      setExporting(false);
    }
  }, [exportType]);

  const handleImport = useCallback(async () => {
    if (!isDesktopRuntime()) {
      notifyWarning(
        getDataTransferLabel("settings.data.notify.cancelled"),
        getDataTransferLabel("settings.data.notify.noTauri"),
      );
      return;
    }

    try {
      const { pickImportFile } = await import("../../lib/tauriBridge");
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
    } catch (err) {
      notifyError(
        getDataTransferLabel("settings.data.import.failedTitle"),
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      setImporting(false);
    }
  }, [importFilePath, detectedFormat]);

  return (
    <div className="flex flex-col gap-8">
      {/* Export section */}
      <SettingsSection title={getDataTransferLabel("settings.data.export.heading")}>
        <SettingsCard>
          <div className="flex items-start justify-between p-4">
            <div className="flex-1 mr-4">
              <div className="flex items-center gap-2 mb-1">
                <Upload size={16} className="text-muted-foreground" />
                <h5 className="text-sm font-medium">
                  {getDataTransferLabel("settings.data.export.backupTitle")}
                </h5>
              </div>
              <p className="text-xs text-muted-foreground">
                {getDataTransferLabel("settings.data.export.backupDescription")}
              </p>
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={handleExportBackup}
              disabled={estimating || exporting}
            >
              {estimating
                ? getDataTransferLabel("settings.data.export.estimating")
                : getDataTransferLabel("settings.data.export.backupButton")}
            </Button>
          </div>

          <div className="flex items-start justify-between p-4">
            <div className="flex-1 mr-4">
              <div className="flex items-center gap-2 mb-1">
                <FileUp size={16} className="text-muted-foreground" />
                <h5 className="text-sm font-medium">
                  {getDataTransferLabel("settings.data.export.dtiTitle")}
                </h5>
              </div>
              <p className="text-xs text-muted-foreground">
                {getDataTransferLabel("settings.data.export.dtiDescription")}
              </p>
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={handleExportDTI}
              disabled={estimating || exporting}
            >
              {estimating
                ? getDataTransferLabel("settings.data.export.estimating")
                : getDataTransferLabel("settings.data.export.dtiButton")}
            </Button>
          </div>
        </SettingsCard>
      </SettingsSection>

      {/* Import section */}
      <SettingsSection title={getDataTransferLabel("settings.data.import.heading")}>
        <SettingsCard divided={false} className="p-4">
          <div className="flex items-start justify-between">
            <div className="flex-1 mr-4">
              <div className="flex items-center gap-2 mb-1">
                <Download size={16} className="text-muted-foreground" />
                <h5 className="text-sm font-medium">
                  {getDataTransferLabel("settings.data.import.title")}
                </h5>
              </div>
              <p className="text-xs text-muted-foreground">
                {getDataTransferLabel("settings.data.import.description")}
              </p>
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={handleImport}
              disabled={detecting || importing}
            >
              {detecting
                ? getDataTransferLabel("settings.data.import.detecting")
                : importing
                  ? getDataTransferLabel("settings.data.import.importing")
                  : getDataTransferLabel("settings.data.import.button")}
            </Button>
          </div>
        </SettingsCard>
      </SettingsSection>

      {/* Export confirmation dialog */}
      <Dialog open={exportDialogOpen} onOpenChange={setExportDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{getDataTransferLabel("settings.data.export.confirmTitle")}</DialogTitle>
            <DialogDescription>
              {exportType === "backup"
                ? getDataTransferLabel("settings.data.export.confirmBackup")
                : getDataTransferLabel("settings.data.export.confirmDti")}
            </DialogDescription>
          </DialogHeader>

          {estimate ? (
            <div className="py-2">
              <p className="text-sm text-muted-foreground">
                {formatDataTransferLabel("settings.data.export.estimateInfo", {
                  conversations: estimate.conversations,
                  messages: estimate.messages,
                  attachments: estimate.attachments,
                  size: formatBytes(estimate.estimatedBytes),
                })}
              </p>
            </div>
          ) : null}

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setExportDialogOpen(false)}
              disabled={exporting}
            >
              {getDataTransferLabel("settings.data.export.cancel")}
            </Button>
            <Button onClick={confirmExport} disabled={exporting}>
              {exporting
                ? getDataTransferLabel("settings.data.export.exporting")
                : getDataTransferLabel("settings.data.export.confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
    </div>
  );
}
