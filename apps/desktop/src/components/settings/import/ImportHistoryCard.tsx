import { ChevronDown, ChevronRight, Trash2 } from "lucide-react";
import { useState } from "react";
import type { ImportPart, ImportPartItem } from "shared/types";
import { Button, cn } from "ui";
import {
  formatImportLabel,
  getImportLabel,
  getImportPartLabel,
  getImportSourceLabel,
} from "../../../lib/i18n/agent";
import type { ApiImportRecord } from "../../../types/chat";
import { ImportSourceIcon } from "./ImportSourceIcon";
import { importLinkHasAction, openImportLink } from "./importNavigation";

function kindLabel(kind: ApiImportRecord["kind"]): string {
  switch (kind) {
    case "local":
      return getImportLabel("import.history.kind.local");
    case "backup":
      return getImportLabel("import.history.kind.backup");
    case "chatgpt":
      return getImportLabel("import.history.kind.chatgpt");
    case "claude-export":
      return getImportLabel("import.history.kind.claude-export");
  }
}

function actionLabel(link: NonNullable<ImportPartItem["link"]>): string | null {
  switch (link.kind) {
    case "conversation":
      return getImportLabel("import.action.conversation");
    case "mcp":
      return getImportLabel("import.action.mcp");
    case "skill":
      return getImportLabel("import.action.skill");
    case "channel":
      return getImportLabel("import.action.channel");
    case "project":
      return getImportLabel("import.action.project");
    case "settings-tab":
      return getImportLabel("import.action.settings-tab");
    case "prompt":
      return null;
  }
}

function statusLabel(status: ImportPartItem["status"]): string {
  switch (status) {
    case "imported":
      return getImportLabel("import.status.imported");
    case "skipped":
      return getImportLabel("import.status.skipped");
    case "needsAction":
      return getImportLabel("import.status.needsAction");
  }
}

function StatusDot({ status }: { status: ImportPartItem["status"] }) {
  return (
    <span
      className={cn(
        "inline-block h-2 w-2 shrink-0 rounded-full",
        status === "imported" && "bg-emerald-500",
        status === "needsAction" && "bg-orange-500",
        status === "skipped" && "bg-muted-foreground/40",
      )}
    />
  );
}

/** One record item with its status and (when the link resolves) a jump action. */
export function ImportItemRow({ item }: { item: ImportPartItem }) {
  const label = item.link && importLinkHasAction(item.link) ? actionLabel(item.link) : null;
  return (
    <div className="flex items-center gap-2 py-1 pl-8 pr-2 text-xs">
      <StatusDot status={item.status} />
      {/* Block-level truncate: inline spans cannot clip, so the row itself does. */}
      <div className="min-w-0 flex-1 truncate" title={item.detail}>
        <span>{item.label}</span>
        {item.detail ? <span className="ml-2 text-muted-foreground">{item.detail}</span> : null}
      </div>
      <span className="shrink-0 text-muted-foreground">{statusLabel(item.status)}</span>
      {label && item.link ? (
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-xs"
          onClick={() => {
            if (item.link) void openImportLink(item.link);
          }}
        >
          {label}
        </Button>
      ) : null}
    </div>
  );
}

function PartRow({ part, defaultOpen }: { part: ImportPart; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const total = part.imported + part.skipped + part.needsAction;
  const hidden = Math.max(0, total - part.items.length);
  return (
    <div className="border-t border-border/40">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-muted/40"
      >
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <StatusDot status={part.needsAction > 0 ? "needsAction" : "imported"} />
        <span className="flex-1">{getImportPartLabel(part.type)}</span>
        <span className="text-xs text-muted-foreground">
          {formatImportLabel("import.history.partSummary", {
            imported: part.imported,
            skipped: part.skipped,
          })}
          {part.needsAction > 0
            ? ` · ${formatImportLabel("import.history.partNeedsAction", { count: part.needsAction })}`
            : ""}
        </span>
      </button>
      {open ? (
        <div className="pb-2">
          {part.note ? (
            <p className="pl-8 pr-2 text-xs text-muted-foreground">{part.note}</p>
          ) : null}
          {part.items.length === 0 ? (
            <p className="pl-8 pr-2 text-xs text-muted-foreground">
              {getImportLabel("import.history.noItems")}
            </p>
          ) : (
            part.items.map((item, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: items are plain snapshots with no stable id
              <ImportItemRow key={`${item.label}-${index}`} item={item} />
            ))
          )}
          {hidden > 0 ? (
            <p className="pl-8 pr-2 pt-1 text-xs text-muted-foreground">
              {formatImportLabel("import.history.itemsTruncated", {
                shown: part.items.length,
                rest: hidden,
              })}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function ImportHistoryCard({
  record,
  expanded,
  onToggle,
  onDelete,
}: {
  record: ApiImportRecord;
  expanded: boolean;
  onToggle: () => void;
  onDelete: () => void;
}) {
  const summary =
    record.totalNeedsAction > 0
      ? formatImportLabel("import.history.cardSummary", {
          imported: record.totalImported,
          needsAction: record.totalNeedsAction,
        })
      : formatImportLabel("import.history.cardSummaryClean", { imported: record.totalImported });
  return (
    <div className="rounded-xl border border-border/50 bg-background/60">
      <div className="flex items-center gap-3 p-3">
        <ImportSourceIcon source={record.source} />
        <button type="button" onClick={onToggle} className="min-w-0 flex-1 text-left">
          <p className="truncate text-sm font-medium">
            {formatImportLabel("import.history.cardTitle", {
              source: getImportSourceLabel(record.source),
            })}
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              {kindLabel(record.kind)}
            </span>
          </p>
          <p className="text-xs text-muted-foreground">
            {new Date(record.createdAt).toLocaleString()} · {summary}
          </p>
        </button>
        <Button
          variant="ghost"
          size="icon"
          className="text-muted-foreground"
          onClick={onDelete}
          title={getImportLabel("import.history.delete")}
        >
          <Trash2 size={16} />
        </Button>
        <Button variant="ghost" size="icon" onClick={onToggle}>
          {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        </Button>
      </div>
      {expanded ? (
        <div>
          {record.parts.map((part) => (
            <PartRow key={part.type} part={part} defaultOpen={part.needsAction > 0} />
          ))}
          {record.errors.length > 0 ? (
            <div className="border-t border-border/40 px-3 py-2 text-xs text-destructive">
              <p className="font-medium">{getImportLabel("import.history.errors")}</p>
              <ul className="list-disc pl-4">
                {record.errors.map((error) => (
                  <li key={error}>{error}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
