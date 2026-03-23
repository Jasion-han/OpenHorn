import { Bot, MessageSquare, PanelLeft, PanelLeftClose, WifiOff } from "lucide-react";
import { Badge, Button } from "ui";
import type { Conversation } from "../../types/chat";
import { useDesktopShellStore } from "../../stores/desktopShellStore";
import { useChatStore } from "../../stores/chatStore";

export function DesktopChatHeader({ conversation }: { conversation: Conversation | null }) {
  const composerMode = useChatStore((state) => state.composerMode);
  const sidebarCollapsed = useDesktopShellStore((state) => state.sidebarCollapsed);
  const setSidebarCollapsed = useDesktopShellStore((state) => state.setSidebarCollapsed);
  const sidecarStatus = useDesktopShellStore((state) => state.sidecarStatus);
  const sidecarError = useDesktopShellStore((state) => state.sidecarError);
  const sidecarLabel =
    sidecarStatus === "connected"
      ? "已连接"
      : sidecarStatus === "loading"
        ? "连接中"
        : sidecarStatus === "error"
          ? "不可用"
          : "待命";

  return (
    <div className="flex items-center justify-between gap-3 border-b border-border/50 px-4 py-3">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <Button
          variant="ghost"
          size="icon-sm"
          className="shrink-0"
          aria-label={sidebarCollapsed ? "打开侧栏" : "收起侧栏"}
          onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
        >
          {sidebarCollapsed ? <PanelLeft size={18} /> : <PanelLeftClose size={18} />}
        </Button>
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold">{conversation?.title || "会话"}</div>
          <div className="mt-1 flex items-center gap-2 text-[11px] text-muted-foreground">
            {sidecarStatus === "error" ? (
              <span className="inline-flex items-center gap-1 text-destructive">
                <WifiOff size={12} />
                {sidecarError || "本地连接不可用"}
              </span>
            ) : (
              <Badge variant="outline">{sidecarLabel}</Badge>
            )}
          </div>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <Badge variant={composerMode === "agent" ? "secondary" : "outline"}>
          {composerMode === "agent" ? <Bot size={12} /> : <MessageSquare size={12} />}
          <span className="ml-1">{composerMode === "agent" ? "Agent" : "Chat"}</span>
        </Badge>
      </div>
    </div>
  );
}
