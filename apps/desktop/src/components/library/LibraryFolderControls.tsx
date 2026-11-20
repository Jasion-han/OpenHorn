import { Check, ChevronDown, Folder } from "lucide-react";
import { type ReactNode, useState } from "react";
import { LIBRARY_LIMITS } from "shared/library";
import type { LibraryFolder } from "shared/types";
import {
  Button,
  cn,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Input,
  Label,
} from "ui";
import { formatLibraryLabel as format, getLibraryLabel as label } from "../../lib/i18n/agent";

export const libraryFolderMenuItemClass = "gap-3 focus:bg-amber-100 focus:text-amber-950";

export function LibraryFolderPicker({
  folders,
  value,
  disabled,
  onChange,
  actionLabel,
  ariaLabel,
  unavailableLabel,
  menuClassName,
  children,
}: {
  folders: LibraryFolder[];
  value: string | null | undefined;
  disabled: boolean;
  onChange(value: string | null | undefined): void;
  actionLabel?: string;
  ariaLabel?: string;
  unavailableLabel?: string;
  menuClassName?: string;
  children?: ReactNode;
}) {
  const isFilter = children !== undefined;
  const choices = [
    ...(isFilter ? [{ id: undefined, name: label("library.allFolders") }] : []),
    { id: null, name: label("library.uncategorized") },
    ...folders,
  ];
  const selected = choices.find((choice) => choice.id === value);
  const chosen = actionLabel
    ? undefined
    : (selected ?? (unavailableLabel ? undefined : choices[0]));
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          size="sm"
          variant="outline"
          disabled={disabled}
          aria-label={
            ariaLabel ??
            actionLabel ??
            label(isFilter ? "library.folderFilter" : "library.moveFolder")
          }
          className={cn("max-w-[190px]", isFilter && "h-9")}
        >
          <Folder size={14} />
          <span className="truncate">{actionLabel ?? chosen?.name ?? unavailableLabel}</span>
          <ChevronDown size={14} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className={cn(
          "max-h-72 min-w-44 max-w-[280px] overflow-y-auto border-stone-200 bg-stone-50 text-stone-900",
          menuClassName,
        )}
      >
        {choices.map((choice) => (
          <DropdownMenuItem
            key={choice.id ?? (choice.id === null ? "uncategorized" : "all")}
            aria-current={choice === chosen ? "true" : undefined}
            className={cn(
              libraryFolderMenuItemClass,
              choice === chosen && "bg-amber-100 text-amber-950",
            )}
            onSelect={() => onChange(choice.id)}
          >
            <span className="min-w-0 flex-1 break-words">{choice.name}</span>
            {choice === chosen && <Check size={14} className="shrink-0" />}
          </DropdownMenuItem>
        ))}
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export type LibraryFolderAction =
  | { kind: "create" }
  | { kind: "rename" | "delete"; folder: LibraryFolder };

export function LibraryFolderDialog({
  action,
  scopeName,
  busy,
  error,
  onClose,
  onSubmit,
}: {
  action: LibraryFolderAction;
  scopeName: string;
  busy: boolean;
  error: string;
  onClose(): void;
  onSubmit(name: string): void;
}) {
  const [name, setName] = useState(action.kind === "create" ? "" : action.folder.name);
  const removing = action.kind === "delete";
  const title = label(
    action.kind === "create"
      ? "library.newFolder"
      : removing
        ? "library.deleteFolder"
        : "library.renameFolder",
  );
  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {removing ? format("library.deleteFolderPrompt", { name }) : scopeName}
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (!busy && (removing || name.trim())) onSubmit(name);
          }}
        >
          {!removing && (
            <div className="space-y-2">
              <Label htmlFor="library-folder-name">{label("library.folderName")}</Label>
              <Input
                id="library-folder-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={LIBRARY_LIMITS.folderNameChars}
                disabled={busy}
              />
            </div>
          )}
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={onClose} disabled={busy} type="button">
              {label("library.cancel")}
            </Button>
            <Button
              disabled={busy || (!removing && !name.trim())}
              type="submit"
              className={
                removing
                  ? "bg-rose-100 text-rose-900 hover:bg-rose-200"
                  : "bg-amber-100 text-amber-950 hover:bg-amber-200"
              }
            >
              {title}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
