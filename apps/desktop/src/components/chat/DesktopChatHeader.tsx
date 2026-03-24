import { PanelLeft, PanelLeftClose } from "lucide-react";
import { Button } from "ui";
import type { Conversation } from "../../types/chat";
import { useDesktopShellStore } from "../../stores/desktopShellStore";

export function DesktopChatHeader({ conversation }: { conversation: Conversation | null }) {
  const sidebarCollapsed = useDesktopShellStore((state) => state.sidebarCollapsed);
  const setSidebarCollapsed = useDesktopShellStore((state) => state.setSidebarCollapsed);

  return (
    <div className="mb-3 flex items-center justify-between gap-2">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <Button
          variant="ghost"
          size="icon-sm"
          className="shrink-0 titlebar-no-drag"
          aria-label={sidebarCollapsed ? "打开侧栏" : "收起侧栏"}
          onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
        >
          {sidebarCollapsed ? <PanelLeft size={18} /> : <PanelLeftClose size={18} />}
        </Button>
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold">{conversation?.title || "会话"}</p>
        </div>
      </div>
    </div>
  );
}
