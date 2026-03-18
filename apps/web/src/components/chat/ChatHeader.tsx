"use client";

import { PanelLeft, PanelLeftClose } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useChatStore } from "@/stores/chatStore";
import { useUIStore } from "@/stores/uiStore";

export function ChatHeader() {
  const { currentConversation } = useChatStore();
  const { sidebarCollapsed, setSidebarCollapsed } = useUIStore();

  const sidebarToggle = (
    <Button
      variant="ghost"
      size="icon-sm"
      className="hidden sm:inline-flex titlebar-no-drag shrink-0"
      aria-label={sidebarCollapsed ? "Open left sidebar" : "Collapse sidebar"}
      onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
    >
      {sidebarCollapsed ? <PanelLeft size={18} /> : <PanelLeftClose size={18} />}
    </Button>
  );

  if (!currentConversation) {
    return (
      <div className="flex items-center justify-between mb-3 gap-2">
        {sidebarToggle}
        <span className="font-semibold">会话</span>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-between mb-3 gap-2">
      {sidebarToggle}
      <div className="min-w-0 flex-1">
        <p className="font-semibold truncate">{currentConversation.title}</p>
      </div>
    </div>
  );
}
