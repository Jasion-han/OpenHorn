import { PanelLeft } from "lucide-react";
import { Button, cn } from "ui";
import { getSidebarLabel } from "../../lib/i18n/agent";
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

  return (
    <div className="relative flex h-dvh w-dvw overflow-hidden bg-background">
      {/* Flush panes divided by a hairline (rather than two floating cards): the
          sidebar carries a faint tint, the content pane stays plain. */}
      {!sidebarCollapsed && (
        <div className="w-[272px] shrink-0 overflow-hidden border-r border-border/60 bg-muted/60">
          <DesktopLeftSidebar />
        </div>
      )}

      {/*
        The only way back from a collapsed sidebar, and it lives here rather than
        in each view: the collapse control sits inside the sidebar, so it is
        reachable from every view — an expand button owned by individual views
        left whichever view lacked one (settings) with no way out.
        The content pane is padded to match so nothing renders underneath it.
      */}
      {sidebarCollapsed && (
        <div
          className="absolute left-2 z-20"
          style={{ top: "calc(0.5rem + env(safe-area-inset-top, 0px))" }}
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

      <div className="min-w-0 flex-1">
        <div
          className={cn(
            "h-full min-h-0 overflow-hidden",
            isCompact ? "p-4" : "p-2",
            sidebarCollapsed && "pl-11",
          )}
          style={{ paddingTop: "calc(0.5rem + env(safe-area-inset-top, 0px))" }}
        >
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
