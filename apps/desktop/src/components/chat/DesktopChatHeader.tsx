import { Bot, MessageSquare, WifiOff } from "lucide-react";
import { Badge } from "ui";
import type { Conversation } from "../../types/chat";
import { useDesktopShellStore } from "../../stores/desktopShellStore";
import { useChatStore } from "../../stores/chatStore";

export function DesktopChatHeader({ conversation }: { conversation: Conversation | null }) {
  const composerMode = useChatStore((state) => state.composerMode);
  const sidecarStatus = useDesktopShellStore((state) => state.sidecarStatus);
  const sidecarError = useDesktopShellStore((state) => state.sidecarError);

  return (
    <div className="flex items-center justify-between gap-3 border-b border-border/50 px-4 py-3">
      <div className="min-w-0">
        <div className="truncate text-sm font-semibold">
          {conversation?.title || "选择一个会话开始"}
        </div>
        <div className="mt-1 flex items-center gap-2 text-[11px] text-muted-foreground">
          <span>{conversation ? "Desktop Chat" : "Chat Shell"}</span>
          {sidecarStatus === "error" ? (
            <span className="inline-flex items-center gap-1 text-destructive">
              <WifiOff size={12} />
              {sidecarError || "Sidecar unavailable"}
            </span>
          ) : (
            <Badge variant="outline">{sidecarStatus}</Badge>
          )}
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
