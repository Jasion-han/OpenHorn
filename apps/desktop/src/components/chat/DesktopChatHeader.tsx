import { PanelLeft, PanelLeftClose } from "lucide-react";
import { Button } from "ui";
import { displayConversationTitle, formatConversationTime } from "../../lib/conversationTitle";
import { useDesktopShellStore } from "../../stores/desktopShellStore";
import type { Conversation } from "../../types/chat";

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
        <div />
      </div>
    );
  }

  return (
    <div className="mb-3 flex items-center justify-between gap-2">
      {sidebarToggle}
      <div className="min-w-0 flex-1">
        <p className="truncate font-semibold">{displayConversationTitle(conversation.title)}</p>
        <p className="truncate text-xs text-muted-foreground">
          {formatConversationTime(conversation.createdAt)}
        </p>
      </div>
    </div>
  );
}
