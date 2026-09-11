import { Download, FileUp, HardDrive, Loader2, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ImportSource } from "shared/types";
import { Button, SettingsCard, SettingsSection } from "ui";
import {
  formatImportLabel,
  getImportLabel,
  getImportPartLabel,
  getImportSourceLabel,
} from "../../lib/i18n/agent";
import { notifyError } from "../../lib/notify";
import { isDesktopRuntime, pickMcpConfigFile } from "../../lib/tauriBridge";
import { BACKEND_UP_EVENT } from "../../stores/backendStatusStore";
import { useDesktopShellStore } from "../../stores/desktopShellStore";
import {
  collectNeedsAction,
  type ImportSourceSummary,
  summaryHasContent,
  useImportStore,
} from "../../stores/importStore";
import { ImportHistoryCard, ImportItemRow } from "./import/ImportHistoryCard";
import { ImportSourceDialog } from "./import/ImportSourceDialog";
import { ImportSourceIcon } from "./import/ImportSourceIcon";

/** "会话 217 · MCP 3 · 技能 9 · 全局指令" — only parts that have something. */
function describeSummary(summary: ImportSourceSummary): string {
  const bits: string[] = [];
  const push = (part: string, count: number) => {
    if (count <= 0) return;
    bits.push(
      formatImportLabel("import.detected.partCount", { part: getImportPartLabel(part), count }),
    );
  };
  push("conversations", summary.conversations?.count ?? 0);
  push("mcp", summary.mcp?.entries.length ?? 0);
  push("skills", summary.skills?.entries.length ?? 0);
  push("prompts", summary.prompts?.count ?? 0);
  push("credentials", summary.credentials?.entries.length ?? 0);
  if (summary.instructions && summary.instructions.count > 0) {
    bits.push(getImportPartLabel("instructions"));
  }
  return bits.length > 0 ? bits.join(" · ") : getImportLabel("import.detected.summaryEmpty");
}

export function ImportSettings() {
  const scanning = useImportStore((state) => state.scanning);
  const scanned = useImportStore((state) => state.scanned);
  const scanError = useImportStore((state) => state.scanError);
  const sources = useImportStore((state) => state.sources);
  const scan = useImportStore((state) => state.scan);
  const addPickedMcp = useImportStore((state) => state.addPickedMcp);
  const records = useImportStore((state) => state.records);
  const recordsCursor = useImportStore((state) => state.recordsCursor);
  const recordsLoading = useImportStore((state) => state.recordsLoading);
  const recordsError = useImportStore((state) => state.recordsError);
  const loadRecords = useImportStore((state) => state.loadRecords);
  const loadMoreRecords = useImportStore((state) => state.loadMoreRecords);
  const removeRecord = useImportStore((state) => state.removeRecord);
  const setSettingsTab = useDesktopShellStore((state) => state.setSettingsTab);

  const [dialogSource, setDialogSource] = useState<ImportSource | null>(null);
  const [expandedRecords, setExpandedRecords] = useState<Set<string>>(new Set());

  const refresh = useCallback(() => {
    void scan();
    void loadRecords();
  }, [scan, loadRecords]);

  // The tab is lazily mounted and kept alive, so this runs once per app session
  // (plus whenever the backend comes back up).
  useEffect(() => {
    refresh();
    window.addEventListener(BACKEND_UP_EVENT, refresh);
    return () => window.removeEventListener(BACKEND_UP_EVENT, refresh);
  }, [refresh]);

  const availableSources = useMemo(
    () => sources.filter((row) => row.available && summaryHasContent(row)),
    [sources],
  );
  const dialogSummary = useMemo(
    () => (dialogSource ? (sources.find((row) => row.source === dialogSource) ?? null) : null),
    [sources, dialogSource],
  );
  const needsAction = useMemo(() => collectNeedsAction(records), [records]);

  const toggleRecord = (id: string) => {
    setExpandedRecords((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleDone = (recordIds: string[]) => {
    setDialogSource(null);
    if (recordIds.length > 0) {
      setExpandedRecords((prev) => new Set([...prev, ...recordIds]));
    }
  };

  const handlePickConfig = async () => {
    try {
      const found = await pickMcpConfigFile();
      if (found === null) return;
      if (found.length === 0) {
        notifyError(
          getImportLabel("import.dialog.failedTitle"),
          getImportLabel("import.empty.pickConfigNone"),
        );
        return;
      }
      addPickedMcp(found);
      setDialogSource("file");
    } catch (error) {
      notifyError(
        getImportLabel("import.dialog.failedTitle"),
        error instanceof Error ? error.message : getImportLabel("import.empty.pickConfigFailed"),
      );
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await removeRecord(id);
    } catch (error) {
      notifyError(
        getImportLabel("import.dialog.failedTitle"),
        error instanceof Error ? error.message : getImportLabel("import.history.deleteFailed"),
      );
    }
  };

  const desktop = isDesktopRuntime();
  const showEmpty = scanned && !scanning && availableSources.length === 0;

  return (
    <div className="flex flex-col gap-8">
      <SettingsSection
        title={getImportLabel("import.detected.title")}
        description={getImportLabel("import.detected.description")}
        action={
          <div className="flex items-center gap-2">
            {desktop ? (
              <Button size="sm" variant="outline" onClick={() => void handlePickConfig()}>
                <FileUp size={16} /> {getImportLabel("import.empty.pickConfig")}
              </Button>
            ) : null}
            <Button size="sm" variant="outline" onClick={() => void scan()} disabled={scanning}>
              {scanning ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}{" "}
              {getImportLabel("import.detected.rescan")}
            </Button>
          </div>
        }
      >
        <SettingsCard divided={false} className="p-4">
          {scanError ? (
            <p className="mb-3 text-xs text-destructive">
              {formatImportLabel("import.detected.scanFailed", { message: scanError })}
            </p>
          ) : null}
          {!desktop ? (
            <p className="mb-3 text-xs text-muted-foreground">
              {getImportLabel("import.detected.desktopOnly")}
            </p>
          ) : null}
          {scanning && availableSources.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {getImportLabel("import.detected.scanning")}
            </p>
          ) : showEmpty ? (
            <div className="flex flex-col items-start gap-3">
              <p className="text-sm font-medium">{getImportLabel("import.empty.title")}</p>
              <p className="text-sm text-muted-foreground">
                {getImportLabel("import.empty.description")}
              </p>
              <div className="flex items-center gap-2">
                {desktop ? (
                  <Button size="sm" variant="outline" onClick={() => void handlePickConfig()}>
                    <FileUp size={16} /> {getImportLabel("import.empty.pickConfig")}
                  </Button>
                ) : null}
                <Button size="sm" variant="outline" onClick={() => setSettingsTab("data")}>
                  <HardDrive size={16} /> {getImportLabel("import.empty.fromBackup")}
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {availableSources.map((row) => (
                <div
                  key={row.source}
                  className="flex items-center justify-between gap-3 rounded-xl border border-border/50 bg-background/60 p-3"
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <ImportSourceIcon source={row.source} />
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">
                        {getImportSourceLabel(row.source)}
                      </p>
                      <p className="truncate text-xs text-muted-foreground">
                        {describeSummary(row)}
                      </p>
                    </div>
                  </div>
                  <Button size="sm" onClick={() => setDialogSource(row.source)}>
                    <Download size={16} /> {getImportLabel("import.detected.import")}
                  </Button>
                </div>
              ))}
            </div>
          )}
        </SettingsCard>
      </SettingsSection>

      {needsAction.length > 0 ? (
        <SettingsSection
          title={getImportLabel("import.needsAction.title")}
          description={getImportLabel("import.needsAction.description")}
        >
          <SettingsCard divided={false} className="p-2">
            {needsAction.map((entry, index) => (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: items carry no stable id beyond position within the record
                key={`${entry.recordId}-${entry.partType}-${index}`}
                className="flex items-center gap-2"
              >
                <span className="shrink-0 pl-2 text-xs text-muted-foreground">
                  {getImportSourceLabel(entry.source)} · {getImportPartLabel(entry.partType)}
                </span>
                <div className="min-w-0 flex-1">
                  <ImportItemRow item={entry.item} />
                </div>
              </div>
            ))}
          </SettingsCard>
        </SettingsSection>
      ) : null}

      <SettingsSection
        title={getImportLabel("import.history.title")}
        description={getImportLabel("import.history.description")}
      >
        {recordsError ? (
          <p className="text-xs text-destructive">{recordsError}</p>
        ) : records.length === 0 ? (
          <SettingsCard divided={false} className="p-4">
            <p className="text-sm text-muted-foreground">
              {recordsLoading
                ? getImportLabel("import.history.loading")
                : getImportLabel("import.history.empty")}
            </p>
          </SettingsCard>
        ) : (
          <div className="flex flex-col gap-2">
            {records.map((record) => (
              <ImportHistoryCard
                key={record.id}
                record={record}
                expanded={expandedRecords.has(record.id)}
                onToggle={() => toggleRecord(record.id)}
                onDelete={() => void handleDelete(record.id)}
              />
            ))}
            {recordsCursor ? (
              <Button
                variant="ghost"
                size="sm"
                className="self-center"
                onClick={() => void loadMoreRecords()}
                disabled={recordsLoading}
              >
                {recordsLoading
                  ? getImportLabel("import.history.loading")
                  : getImportLabel("import.history.loadMore")}
              </Button>
            ) : null}
          </div>
        )}
      </SettingsSection>

      <ImportSourceDialog
        summary={dialogSummary}
        open={dialogSource !== null}
        onOpenChange={(open) => {
          if (!open) setDialogSource(null);
        }}
        onDone={handleDone}
      />
    </div>
  );
}
