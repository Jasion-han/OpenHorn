import { FileCode2, Globe, PanelRightClose, X } from "lucide-react";
import { useCallback, useEffect, useRef } from "react";
import { Button, cn } from "ui";
import { getPreviewLabel } from "../../lib/i18n/agent";
import { previewTabIdFromLabel } from "../../lib/previewWebview";
import { fileBasename } from "../../lib/referenceLink";
import {
  onPreviewWebviewPageLoad,
  onPreviewWebviewTitle,
  previewWebviewHistoryState,
} from "../../lib/tauriBridge";
import {
  PREVIEW_PANEL_MAX_WINDOW_RATIO,
  PREVIEW_PANEL_MIN_WIDTH,
  type PreviewTab,
  usePreviewPanelStore,
} from "../../stores/previewPanelStore";
import { DesktopFilePreview } from "./DesktopFilePreview";
import { DesktopWebPreview } from "./DesktopWebPreview";

function tabTitle(tab: PreviewTab): string {
  if (tab.kind === "file") return fileBasename(tab.path);
  if (tab.title?.trim()) return tab.title.trim();
  try {
    return new URL(tab.url).hostname || getPreviewLabel("preview.tab.untitled");
  } catch {
    return getPreviewLabel("preview.tab.untitled");
  }
}

/**
 * Right-hand column of the shell: a tab strip over either a workspace file
 * (code view) or an embedded browser. Every tab stays mounted so a web tab's
 * child webview survives switching; only the active one is displayed.
 */
export function DesktopPreviewPanel({ collapsed = false }: { collapsed?: boolean }) {
  const width = usePreviewPanelStore((state) => state.width);
  const tabs = usePreviewPanelStore((state) => state.tabs);
  const activeTabId = usePreviewPanelStore((state) => state.activeTabId);
  const activateTab = usePreviewPanelStore((state) => state.activateTab);
  const closeTab = usePreviewPanelStore((state) => state.closeTab);
  const collapsePanel = usePreviewPanelStore((state) => state.collapsePanel);
  const setWidth = usePreviewPanelStore((state) => state.setWidth);
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);

  // Page events from the child webviews: keep the tab's url/title/loading
  // current so the address bar and tab strip follow in-page navigation, and
  // re-query native back/forward availability on every load phase (the
  // back-forward list changes as soon as a navigation starts).
  useEffect(() => {
    const offPageLoad = onPreviewWebviewPageLoad(({ label, url, phase }) => {
      const id = previewTabIdFromLabel(label);
      if (!id) return;
      usePreviewPanelStore.getState().updateTab(id, { url, loading: phase === "started" });
      void previewWebviewHistoryState(label)
        .then((history) => usePreviewPanelStore.getState().updateTab(id, history))
        .catch(() => {});
    });
    const offTitle = onPreviewWebviewTitle(({ label, title }) => {
      const id = previewTabIdFromLabel(label);
      if (!id) return;
      usePreviewPanelStore.getState().updateTab(id, { title });
    });
    return () => {
      offPageLoad();
      offTitle();
    };
  }, []);

  const handleResizePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      e.preventDefault();
      dragRef.current = { startX: e.clientX, startWidth: width };
      e.currentTarget.setPointerCapture(e.pointerId);
      document.body.classList.add("select-none", "cursor-col-resize");
    },
    [width],
  );

  const handleResizePointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (!drag) return;
      const max = Math.floor(window.innerWidth * PREVIEW_PANEL_MAX_WINDOW_RATIO);
      const next = Math.min(
        max,
        Math.max(PREVIEW_PANEL_MIN_WIDTH, drag.startWidth + (drag.startX - e.clientX)),
      );
      setWidth(next);
    },
    [setWidth],
  );

  const endResize = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {}
    document.body.classList.remove("select-none", "cursor-col-resize");
  }, []);

  useEffect(() => {
    return () => document.body.classList.remove("select-none", "cursor-col-resize");
  }, []);

  return (
    <div
      className={cn(
        "relative flex h-full shrink-0 flex-col border-l border-border/60 bg-background",
        // Collapsed keeps the column mounted (web tabs own native child
        // webviews that would be destroyed with it) but takes it out of layout.
        collapsed && "hidden",
      )}
      style={{ width }}
    >
      {/* Pointer-only affordance (mirrors the composer's drop zone): the panel
          width is not keyboard-adjustable, so it is hidden from AT. */}
      <div
        aria-hidden="true"
        title={getPreviewLabel("preview.panel.resize")}
        onPointerDown={handleResizePointerDown}
        onPointerMove={handleResizePointerMove}
        onPointerUp={endResize}
        onPointerCancel={endResize}
        className="absolute inset-y-0 left-0 z-20 w-1 cursor-col-resize transition-colors hover:bg-foreground/15 active:bg-foreground/25"
      />

      <div
        data-tauri-drag-region
        className="flex h-10 shrink-0 items-center gap-1 border-b border-border/60 pl-2 pr-1.5"
      >
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {tabs.map((tab) => {
            const isActive = tab.id === activeTabId;
            return (
              <div
                key={tab.id}
                className={cn(
                  "group flex h-7 max-w-[180px] shrink-0 items-center gap-1 rounded-md pl-2 pr-1 text-[12px] transition-colors",
                  isActive
                    ? "bg-muted text-foreground"
                    : "text-foreground/60 hover:bg-muted/60 hover:text-foreground/85",
                )}
              >
                <button
                  type="button"
                  onClick={() => activateTab(tab.id)}
                  title={tab.kind === "file" ? tab.path : tab.url}
                  className="flex min-w-0 items-center gap-1.5"
                >
                  {tab.kind === "file" ? (
                    <FileCode2 size={13} className="shrink-0 opacity-75" />
                  ) : (
                    <Globe size={13} className="shrink-0 opacity-75" />
                  )}
                  <span className="truncate">{tabTitle(tab)}</span>
                </button>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    closeTab(tab.id);
                  }}
                  aria-label={getPreviewLabel("preview.tab.close")}
                  title={getPreviewLabel("preview.tab.close")}
                  className={cn(
                    "flex size-5 shrink-0 items-center justify-center rounded transition-colors hover:bg-foreground/10",
                    isActive ? "opacity-70" : "opacity-0 group-hover:opacity-70",
                  )}
                >
                  <X size={12} />
                </button>
              </div>
            );
          })}
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          className="titlebar-no-drag"
          aria-label={getPreviewLabel("preview.panel.collapse")}
          title={`${getPreviewLabel("preview.panel.collapse")} (⌘⇧E)`}
          onClick={collapsePanel}
        >
          <PanelRightClose size={17} />
        </Button>
      </div>

      <div className="relative min-h-0 flex-1">
        {tabs.map((tab) => {
          const isActive = tab.id === activeTabId;
          return (
            <div key={tab.id} className={cn("absolute inset-0", !isActive && "hidden")}>
              {tab.kind === "file" ? (
                // Collapsed counts as inactive: the initial centre-on-line
                // scroll must wait until the tab can actually be laid out.
                <DesktopFilePreview tab={tab} active={isActive && !collapsed} />
              ) : (
                <DesktopWebPreview tab={tab} active={isActive} />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
