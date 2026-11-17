import { FileUp, Upload } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
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
import { saveAttachment } from "../../lib/attachmentPreview";
import { dataTransferErrorMessage } from "../../lib/dataTransferError";
import { formatDataTransferLabel, getDataTransferLabel } from "../../lib/i18n/agent";
import { notifyError, notifySuccess, notifyWarning } from "../../lib/notify";
import { createServerApi } from "../../lib/serverApi";
import { isDesktopRuntime } from "../../lib/tauriBridge";
import { useDesktopShellStore } from "../../stores/desktopShellStore";
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
  const [exportNotes, setExportNotes] = useState<string[]>([]);
  const submission = useRef(false);
  const completedExport = useRef(false);
  const estimatingRequest = useRef(0);
  const view = useDesktopShellStore((state) => state.activeView);
  const tab = useDesktopShellStore((state) => state.settingsTab);
  // biome-ignore lint/correctness/useExhaustiveDependencies: hidden settings tabs must not reopen an estimate dialog later
  useEffect(() => {
    estimatingRequest.current++;
    setEstimating(false);
    setExportDialogOpen(false);
    return () => {
      estimatingRequest.current++;
    };
  }, [view, tab]);

  const handleExportBackup = useCallback(async () => {
    const request = ++estimatingRequest.current;
    setEstimating(true);
    try {
      const est = await api.dataTransfer.estimateExport();
      if (request !== estimatingRequest.current) return;
      setEstimate(est);
      completedExport.current = false;
      setExportType("backup");
      setExportDialogOpen(true);
    } catch (err) {
      if (request !== estimatingRequest.current) return;
      notifyError(
        getDataTransferLabel("settings.data.export.failedTitle"),
        dataTransferErrorMessage(err),
      );
    } finally {
      if (request === estimatingRequest.current) setEstimating(false);
    }
  }, []);

  const handleExportDTI = useCallback(async () => {
    const request = ++estimatingRequest.current;
    setEstimating(true);
    try {
      const est = await api.dataTransfer.estimateExport();
      if (request !== estimatingRequest.current) return;
      setEstimate(est);
      completedExport.current = false;
      setExportType("dti");
      setExportDialogOpen(true);
    } catch (err) {
      if (request !== estimatingRequest.current) return;
      notifyError(
        getDataTransferLabel("settings.data.export.failedTitle"),
        dataTransferErrorMessage(err),
      );
    } finally {
      if (request === estimatingRequest.current) setEstimating(false);
    }
  }, []);

  const confirmExport = useCallback(async () => {
    if (submission.current || completedExport.current) return;
    if (!isDesktopRuntime()) {
      notifyWarning(
        getDataTransferLabel("settings.data.notify.cancelled"),
        getDataTransferLabel("settings.data.notify.noTauri"),
      );
      return;
    }

    submission.current = true;
    const request = estimatingRequest.current;
    setExporting(true);
    setExportNotes([]);
    try {
      if (exportType === "backup") {
        const { pickExportDir } = await import("../../lib/tauriBridge");
        const dir = await pickExportDir();
        if (request !== estimatingRequest.current) return;
        if (!dir) {
          completedExport.current = true;
          setExportDialogOpen(false);
          return;
        }
        const result = await api.dataTransfer.exportBackup(dir);
        const manifest = result.manifest as {
          attachmentFiles?: { missing?: unknown[] };
          configuration?: { mcpRequiresSetup?: unknown[]; omittedSettings?: number };
        };
        const notes: string[] = [];
        if (
          Array.isArray(manifest.attachmentFiles?.missing) &&
          manifest.attachmentFiles.missing.length
        ) {
          notes.push(
            formatDataTransferLabel("settings.data.export.missingFiles", {
              count: manifest.attachmentFiles.missing.length,
            }),
          );
        }
        if (
          Array.isArray(manifest.configuration?.mcpRequiresSetup) &&
          manifest.configuration.mcpRequiresSetup.length
        ) {
          notes.push(
            formatDataTransferLabel("settings.data.export.connectorsNeedSetup", {
              count: manifest.configuration.mcpRequiresSetup.length,
            }),
          );
        }
        const omitted = manifest.configuration?.omittedSettings;
        if (typeof omitted === "number" && Number.isSafeInteger(omitted) && omitted > 0) {
          notes.push(
            formatDataTransferLabel("settings.data.export.omittedSettings", { count: omitted }),
          );
        }
        setExportNotes(notes);
        completedExport.current = true;
        setExportDialogOpen(false);
        notifySuccess(
          getDataTransferLabel("settings.data.export.successTitle"),
          formatDataTransferLabel("settings.data.export.successBody", {
            path: result.filePath,
          }),
        );
      } else {
        const data = await api.dataTransfer.exportDTI();
        if (request !== estimatingRequest.current) return;
        const jsonStr = JSON.stringify(data, null, 2);
        const blob = new Blob([jsonStr], { type: "application/json" });
        const path = await saveAttachment(
          blob,
          `openhorn-conversations-${new Date().toISOString().slice(0, 10)}.json`,
        );
        completedExport.current = true;
        setExportDialogOpen(false);
        if (!path) return;
        notifySuccess(
          getDataTransferLabel("settings.data.export.successTitle"),
          formatDataTransferLabel("settings.data.export.successBody", {
            path,
          }),
        );
      }
    } catch (err) {
      notifyError(
        getDataTransferLabel("settings.data.export.failedTitle"),
        dataTransferErrorMessage(err),
      );
    } finally {
      submission.current = false;
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

      {exportNotes.length > 0 ? (
        <output
          aria-live="polite"
          className="block rounded-lg border p-4 text-sm text-muted-foreground space-y-2"
        >
          {exportNotes.map((note) => (
            <p key={note}>{note}</p>
          ))}
        </output>
      ) : null}

      {/* Import: local sources + backup file row + needs-action + history */}
      <ImportSettings />

      {/* Export confirmation dialog */}
      <Dialog
        open={exportDialogOpen}
        onOpenChange={(open) => {
          if (!submission.current) setExportDialogOpen(open);
        }}
      >
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
                {formatDataTransferLabel(
                  exportType === "backup"
                    ? "settings.data.export.estimateInfo"
                    : "settings.data.export.estimateDtiInfo",
                  {
                    conversations: estimate.conversations,
                    messages: estimate.messages,
                    attachments: estimate.attachments,
                    size: formatBytes(estimate.estimatedBytes),
                  },
                )}
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
