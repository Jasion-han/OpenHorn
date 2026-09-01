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
  activeView: "chat" | "settings" | "scheduled-tasks";
}) {
  const needsOuterPadding = activeView === "settings";
  const nativeScroll = activeView === "settings";
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
    </div>
  );
}
