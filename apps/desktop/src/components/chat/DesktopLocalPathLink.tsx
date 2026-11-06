import { Copy, ExternalLink, FolderOpen, MoreHorizontal } from "lucide-react";
import { createContext, type ReactNode, useContext, useRef } from "react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "ui";
import { canOpenAttachment } from "../../lib/attachmentPreview";
import { type ChatScrollAnchor, captureLocalPathScrollAnchor } from "../../lib/chatScrollAnchor";
import { getPreviewLabel } from "../../lib/i18n/agent";
import { localPathErrorLabel } from "../../lib/localPathReference";
import { notifyError, notifySuccess } from "../../lib/notify";
import { openLocalPath, revealLocalPath } from "../../lib/tauriBridge";
import { usePreviewPanelStore } from "../../stores/previewPanelStore";

export const LocalPathLinkContext = createContext(false);
export function DesktopLocalPathLink({ path, children }: { path: string; children: ReactNode }) {
  const nested = useContext(LocalPathLinkContext);
  const id = path;
  const origin = useRef<ChatScrollAnchor | undefined>(undefined);
  if (nested) return <>{children}</>;
  const error = (reason: unknown) =>
    notifyError(getPreviewLabel("preview.file.openFailedTitle"), localPathErrorLabel(reason));
  return (
    <span className="group/local-path">
      <button
        type="button"
        data-chat-local-path-id={id}
        className="inline cursor-pointer select-text rounded-sm decoration-foreground/40 underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        title={path}
        draggable={false}
        onPointerDown={(event) => {
          if (event.button === 0)
            origin.current = captureLocalPathScrollAnchor(event.currentTarget, id);
        }}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          const selection = document.getSelection();
          if (
            event.detail > 0 &&
            selection &&
            !selection.isCollapsed &&
            selection.rangeCount &&
            selection.getRangeAt(0).intersectsNode(event.currentTarget)
          )
            return;
          if (event.metaKey || event.ctrlKey) {
            void openLocalPath(path).catch(error);
            return;
          }
          const returnAnchor =
            event.detail > 0
              ? origin.current
              : captureLocalPathScrollAnchor(event.currentTarget, id);
          origin.current = undefined;
          usePreviewPanelStore.getState().openLocalPath({ path, returnAnchor });
        }}
      >
        {children}
      </button>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={getPreviewLabel("preview.local.actions")}
            title={getPreviewLabel("preview.local.actions")}
            className="ml-0.5 inline-flex size-5 items-center justify-center rounded align-middle text-muted-foreground opacity-0 hover:bg-foreground/10 focus-visible:opacity-100 group-hover/local-path:opacity-100 group-focus-within/local-path:opacity-100"
          >
            <MoreHorizontal aria-hidden="true" className="size-3.5" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="z-[110]">
          {canOpenAttachment(path) && (
            <DropdownMenuItem
              onSelect={() => {
                void openLocalPath(path).catch(error);
              }}
            >
              <ExternalLink aria-hidden="true" className="size-4" />
              {getPreviewLabel("preview.file.openWithDefault")}
            </DropdownMenuItem>
          )}
          <DropdownMenuItem
            onSelect={() => {
              void revealLocalPath(path).catch(error);
            }}
          >
            <FolderOpen aria-hidden="true" className="size-4" />
            {getPreviewLabel("preview.file.menu.reveal")}
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => {
              void navigator.clipboard
                .writeText(path)
                .then(() => notifySuccess(getPreviewLabel("preview.file.copied"), path), error);
            }}
          >
            <Copy aria-hidden="true" className="size-4" />
            {getPreviewLabel("preview.local.copyPath")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </span>
  );
}
