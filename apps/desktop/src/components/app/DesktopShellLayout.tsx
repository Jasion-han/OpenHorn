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
    <div className="flex h-dvh w-dvw overflow-hidden bg-gradient-to-br from-background via-background to-muted/20">
      {!sidebarCollapsed && (
        <div className="w-[320px] shrink-0 p-2">
          <div className="h-full overflow-hidden rounded-2xl border border-border/50 bg-background/70 shadow-minimal backdrop-blur-sm">
            <DesktopLeftSidebar />
          </div>
        </div>
      )}

      <div className={cn("min-w-0 flex-1 p-2", !sidebarCollapsed && "pl-0")}>
        <div
          className={cn(
            "h-full min-h-0 overflow-hidden rounded-2xl border border-border/50 bg-background/70 shadow-minimal backdrop-blur-sm",
            isCompact ? "p-4" : "p-2",
          )}
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
