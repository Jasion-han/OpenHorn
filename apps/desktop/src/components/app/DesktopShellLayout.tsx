import { PanelLeft, PanelRightOpen } from "lucide-react";
import { useEffect } from "react";
import { Button, cn } from "ui";
import { getPreviewLabel, getSidebarLabel } from "../../lib/i18n/agent";
import { BACKEND_UP_EVENT } from "../../stores/backendStatusStore";
import { useChatStore } from "../../stores/chatStore";
import { useDesktopShellStore } from "../../stores/desktopShellStore";
import { usePreviewPanelStore } from "../../stores/previewPanelStore";
import { DesktopPreviewPanel } from "../preview/DesktopPreviewPanel";
import { DesktopLeftSidebar } from "./DesktopLeftSidebar";

export function DesktopShellLayout({
  children,
  activeView,
}: {
  children: React.ReactNode;
  activeView: "chat" | "settings" | "scheduled-tasks";
}) {
  const needsOuterPadding = activeView === "settings";
  const nativeScroll = activeView === "settings";
  const sidebarCollapsed = useDesktopShellStore((state) => state.sidebarCollapsed);
  const setSidebarCollapsed = useDesktopShellStore((state) => state.setSidebarCollapsed);
  const loadChannels = useChatStore((state) => state.loadChannels);
  const loadConversations = useChatStore((state) => state.loadConversations);
  const previewOpen = usePreviewPanelStore((state) => state.isOpen);
  const previewCollapsed = usePreviewPanelStore((state) => state.collapsed);
  const previewTabCount = usePreviewPanelStore((state) => state.tabs.length);
  const expandPreview = usePreviewPanelStore((state) => state.expandPanel);
  const togglePreview = usePreviewPanelStore((state) => state.togglePanel);

  // Owned by the shell, not by the sidebar: a collapsed sidebar is unmounted, so
  // loading from there meant starting the app with it collapsed left the store
  // with no channels and no conversations (the composer showed "选择模型" and the
  // list stayed empty until you expanded it).
  useEffect(() => {
    const load = () => {
      void Promise.allSettled([loadChannels(), loadConversations()]);
    };
    load();
    window.addEventListener(BACKEND_UP_EVENT, load);
    return () => window.removeEventListener(BACKEND_UP_EVENT, load);
  }, [loadChannels, loadConversations]);

  // ⌘⇧E / Ctrl+Shift+E — collapse / expand the preview panel. Only meaningful
  // while it has tabs; ⌘N (new conversation) is the only other shell shortcut.
  useEffect(() => {
    if (!previewOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.key.toLowerCase() !== "e" ||
        !(event.metaKey || event.ctrlKey) ||
        !event.shiftKey ||
        event.altKey
      ) {
        return;
      }
      event.preventDefault();
      togglePreview();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [previewOpen, togglePreview]);

  return (
    <div className="flex h-dvh w-dvw overflow-hidden bg-background">
      {/* Flush panes divided by a hairline (rather than two floating cards): the
          sidebar carries a faint tint, the content pane stays plain. */}
      {!sidebarCollapsed && (
        <div className="w-[272px] shrink-0 overflow-hidden border-r border-border/60 bg-muted/60">
          <DesktopLeftSidebar />
        </div>
      )}

      <div className="relative flex min-w-0 flex-1 flex-col">
        {sidebarCollapsed && (
          <div className="absolute left-2 top-2 z-10 titlebar-traffic-light-inset">
            <Button
              variant="ghost"
              size="icon-sm"
              className="titlebar-no-drag"
              aria-label={getSidebarLabel("sidebar.expand")}
              title={getSidebarLabel("sidebar.expand")}
              onClick={() => setSidebarCollapsed(false)}
            >
              <PanelLeft size={17} />
            </Button>
          </div>
        )}

        {previewOpen && previewCollapsed && (
          <div className="absolute right-2 top-2 z-10">
            <Button
              variant="ghost"
              size="icon-sm"
              className="titlebar-no-drag relative"
              aria-label={getPreviewLabel("preview.panel.expand")}
              title={`${getPreviewLabel("preview.panel.expand")} (⌘⇧E)`}
              onClick={expandPreview}
            >
              <PanelRightOpen size={17} />
              {previewTabCount > 0 && (
                <span
                  aria-hidden="true"
                  className="absolute -right-0.5 -top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-foreground/80 px-1 text-[9px] font-medium leading-none text-background"
                >
                  {previewTabCount > 9 ? "9+" : previewTabCount}
                </span>
              )}
            </Button>
          </div>
        )}

        <div
          data-tauri-drag-region
          className={cn("min-h-0 flex-1 overflow-hidden", needsOuterPadding ? "p-4" : "p-2")}
        >
          <div
            className={cn(
              "h-full min-h-0 min-w-0 w-full overflow-x-hidden",
              nativeScroll ? "overflow-y-auto" : "overflow-y-hidden",
            )}
          >
            {children}
          </div>
        </div>
      </div>

      {/* Third column: file / web preview opened from links in replies. Only
          mounted while open so the child webviews it owns are torn down with it;
          collapsing merely hides it so those webviews keep their state. */}
      {previewOpen && <DesktopPreviewPanel collapsed={previewCollapsed} />}
    </div>
  );
}
