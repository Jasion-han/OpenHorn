import { ArrowLeft, FileText, Folder, RefreshCw } from "lucide-react";
import { Button, cn, ScrollArea } from "ui";
import { type FsEntry, parentDir, useIdeStore } from "../stores/ideStore";

function EntryRow({ entry }: { entry: FsEntry }) {
  const openFile = useIdeStore((s) => s.openFile);
  const loadDir = useIdeStore((s) => s.loadDir);

  const onClick = async () => {
    if (entry.kind === "dir") {
      await loadDir(entry.path);
      return;
    }
    await openFile(entry.path);
  };

  return (
    <button
      type="button"
      onClick={() => void onClick()}
      className={cn(
        "w-full flex items-center justify-between gap-2 px-3 py-[7px] rounded-[10px] transition-colors duration-100 text-left cursor-pointer",
        "hover:bg-foreground/[0.04] dark:hover:bg-foreground/[0.04]",
      )}
    >
      <div className="flex items-center gap-2 min-w-0">
        {entry.kind === "dir" ? <Folder size={14} /> : <FileText size={14} />}
        <span className="text-[13px] leading-5 truncate">{entry.name}</span>
      </div>
      <span className="text-xs text-muted-foreground shrink-0">{entry.kind}</span>
    </button>
  );
}

export function FileTree() {
  const entries = useIdeStore((s) => s.entries);
  const currentDir = useIdeStore((s) => s.currentDir);
  const loadDir = useIdeStore((s) => s.loadDir);

  return (
    <div className="h-full min-h-0 flex flex-col p-3">
      <div className="flex items-center justify-between gap-2 pb-2">
        <div className="flex items-center gap-2 min-w-0">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => void loadDir(parentDir(currentDir))}
            disabled={currentDir === "."}
            aria-label="Up"
          >
            <ArrowLeft size={14} />
          </Button>
          <span className="text-sm font-semibold truncate">{currentDir}</span>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => void loadDir(currentDir)}
          aria-label="Refresh"
        >
          <RefreshCw size={14} />
        </Button>
      </div>

      <ScrollArea className="flex-1 min-h-0">
        <div className="flex flex-col gap-0.5 pr-3">
          {entries.map((entry) => (
            <EntryRow key={entry.path} entry={entry} />
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}
