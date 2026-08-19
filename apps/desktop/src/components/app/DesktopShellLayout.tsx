import { PanelLeft } from "lucide-react";
import { useEffect } from "react";
import { Button, cn } from "ui";
import { getSidebarLabel } from "../../lib/i18n/agent";
import { BACKEND_UP_EVENT } from "../../stores/backendStatusStore";
import { useChatStore } from "../../stores/chatStore";
import { useDesktopShellStore } from "../../stores/desktopShellStore";
import { DesktopLeftSidebar } from "./DesktopLeftSidebar";

export function DesktopShellLayout({
  children,
  activeView,
}: {
  children: React.ReactNode;
  activeView: "chat" | "settings";
}) {
  const isCompact = activeView === "settings";
  const sidebarCollapsed = useDesktopShellStore((state) => state.sidebarCollapsed);
  const setSidebarCollapsed = useDesktopShellStore((state) => state.setSidebarCollapsed);
  const loadChannels = useChatStore((state) => state.loadChannels);
  const loadConversations = useChatStore((state) => state.loadConversations);

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

  return (
    <div className="flex h-dvh w-dvw overflow-hidden bg-background">
      {/* Flush panes divided by a hairline (rather than two floating cards): the
          sidebar carries a faint tint, the content pane stays plain. */}
      {!sidebarCollapsed && (
        <div className="w-[272px] shrink-0 overflow-hidden border-r border-border/60 bg-muted/60">
          <DesktopLeftSidebar />
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        {/*
          Collapsing hands the whole width to the content and moves the toggle to
          the top-left — the same spot the sidebar's own collapse button occupies,
          so the control appears to stay put. A narrow left rail was tried first
          and read as a cramped gutter next to the content's own padding.

          The control belongs to the shell rather than to each view: the collapse
          half lives inside the sidebar and is reachable everywhere, so an expand
          button owned by individual views left whichever view lacked one
          (settings) with no way back.
        */}
        {sidebarCollapsed && (
          <div
            data-tauri-drag-region
            className="titlebar-traffic-light-inset shrink-0 px-2 pb-1 pt-2"
          >
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

        {/*
          The traffic lights sit over the sidebar, so the sidebar was the only
          thing reserving a draggable strip. With it expanded the entire right
          half of the window had no drag region at all — the window could only
          be moved by that one top-left corner. This is the right pane's half of
          the same band. No traffic-light inset here (they are over the sidebar),
          and it lines the content up with the collapsed state, which already
          reserved the same 32px above its content.
        */}
        {!sidebarCollapsed && <div data-tauri-drag-region className="titlebar-traffic-light-inset shrink-0" />}

        <div className={cn("min-h-0 flex-1 overflow-hidden", isCompact ? "p-4" : "p-2")}>
          <div
            className={cn(
              "h-full min-h-0 min-w-0 w-full overflow-x-hidden",
              isCompact ? "overflow-y-auto" : "overflow-y-hidden",
            )}
          >
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}
