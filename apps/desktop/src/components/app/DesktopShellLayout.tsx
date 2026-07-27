import { cn } from "ui";
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

  return (
    <div className="flex h-dvh w-dvw overflow-hidden bg-background">
      {/* Flush panes divided by a hairline (rather than two floating cards): the
          sidebar carries a faint tint, the content pane stays plain. */}
      {!sidebarCollapsed && (
        <div className="w-[272px] shrink-0 overflow-hidden border-r border-border/60 bg-muted/60">
          <DesktopLeftSidebar />
        </div>
      )}

      <div className="min-w-0 flex-1">
        <div
          className={cn("h-full min-h-0 overflow-hidden", isCompact ? "p-4" : "p-2")}
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
