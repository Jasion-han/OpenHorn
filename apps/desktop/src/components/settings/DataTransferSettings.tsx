import { FileUp, Upload } from "lucide-react";
import { useCallback, useState } from "react";
import {
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
import type { ExportEstimate } from "../../types/chat";
import { ImportSettings } from "./ImportSettings";

const api = createServerApi();

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export function DataTransferSettings() {
  // Export state
  const [estimating, setEstimating] = useState(false);
  const [estimate, setEstimate] = useState<ExportEstimate | null>(null);
  const [exportDialogOpen, setExportDialogOpen] = useState(false);
  const [exportType, setExportType] = useState<"backup" | "dti">("backup");
  const [exporting, setExporting] = useState(false);

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

      {/* Import: local sources + backup file row + needs-action + history */}
      <ImportSettings />

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
    </div>
  );
}
