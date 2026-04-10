import { PanelLeft, PanelLeftClose } from "lucide-react";
import { Button } from "ui";
import { useDesktopShellStore } from "../../stores/desktopShellStore";
import type { Conversation } from "../../types/chat";
import { DesktopAgentTaskHistoryButton } from "./DesktopAgentTaskHistory";
import { DesktopSidecarWorkspaceBadge } from "./DesktopSidecarWorkspaceBadge";

export function DesktopChatHeader({ conversation }: { conversation: Conversation | null }) {
  const sidebarCollapsed = useDesktopShellStore((state) => state.sidebarCollapsed);
  const setSidebarCollapsed = useDesktopShellStore((state) => state.setSidebarCollapsed);

  const sidebarToggle = (
    <Button
      variant="ghost"
      size="icon-sm"
      className="hidden shrink-0 titlebar-no-drag sm:inline-flex"
      aria-label={sidebarCollapsed ? "Open left sidebar" : "Collapse sidebar"}
      onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
    >
      {sidebarCollapsed ? <PanelLeft size={18} /> : <PanelLeftClose size={18} />}
    </Button>
  );

  if (!conversation) {
    return (
      <div className="mb-3 flex items-center justify-between gap-2">
        {sidebarToggle}
        <span className="font-semibold">会话</span>
        <div className="flex items-center gap-2">
          <DesktopSidecarWorkspaceBadge />
        </div>
      </div>
    );
  }

  return (
    <div className="mb-3 flex items-center justify-between gap-2">
      {sidebarToggle}
      <div className="min-w-0 flex-1">
        <p className="truncate font-semibold">{conversation.title}</p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <DesktopAgentTaskHistoryButton conversationId={conversation.id} />
        <DesktopSidecarWorkspaceBadge />
      </div>
    </div>
  );
}
