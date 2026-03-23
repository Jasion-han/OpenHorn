import { MessageSquarePlus, Search, Settings } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Badge, Button, Input, ScrollArea, cn } from "ui";
import { useDesktopShellStore } from "../../stores/desktopShellStore";
import { useChatStore } from "../../stores/chatStore";

function formatNewConversationTitle() {
  const date = new Date();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const min = String(date.getMinutes()).padStart(2, "0");
  return `新会话 ${mm}-${dd} ${hh}:${min}`;
}

export function DesktopLeftSidebar() {
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);

  const activeView = useDesktopShellStore((state) => state.activeView);
  const setActiveView = useDesktopShellStore((state) => state.setActiveView);
  const sidecarStatus = useDesktopShellStore((state) => state.sidecarStatus);

  const conversations = useChatStore((state) => state.conversations);
  const currentConversation = useChatStore((state) => state.currentConversation);
  const error = useChatStore((state) => state.error);
  const loadChannels = useChatStore((state) => state.loadChannels);
  const loadConversations = useChatStore((state) => state.loadConversations);
  const createConversation = useChatStore((state) => state.createConversation);
  const selectConversation = useChatStore((state) => state.selectConversation);

  useEffect(() => {
    void Promise.allSettled([loadChannels(), loadConversations()]);
  }, [loadChannels, loadConversations]);

  const filteredConversations = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) return conversations;
    return conversations.filter((conversation) =>
      conversation.title.toLowerCase().includes(normalizedQuery),
    );
  }, [conversations, query]);

  const statusBadge = (() => {
    if (sidecarStatus === "connected") return <Badge variant="secondary">connected</Badge>;
    if (sidecarStatus === "loading") return <Badge variant="outline">loading</Badge>;
    if (sidecarStatus === "error") return <Badge variant="destructive">error</Badge>;
    return <Badge variant="outline">{sidecarStatus}</Badge>;
  })();

  const handleCreateConversation = async () => {
    setCreating(true);
    try {
      await createConversation(formatNewConversationTitle());
      setActiveView("chat");
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b border-border/50 px-3 py-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold leading-5">OpenHorn</div>
            <div className="mt-1 flex items-center gap-2 text-[11px] text-muted-foreground">
              <span>Desktop</span>
              {statusBadge}
            </div>
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-2 p-2">
        <Button onClick={() => void handleCreateConversation()} disabled={creating}>
          <MessageSquarePlus size={16} />
          新会话
        </Button>

        <div className="relative">
          <Search
            size={14}
            className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            placeholder="搜索会话..."
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="pl-9"
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden px-2 pb-2">
        <ScrollArea className="h-full">
          <div className="flex flex-col gap-1 pr-3">
            {filteredConversations.map((conversation) => (
              <button
                key={conversation.id}
                type="button"
                onClick={() => {
                  setActiveView("chat");
                  void selectConversation(conversation.id);
                }}
                className={cn(
                  "flex items-center justify-between rounded-[10px] border border-transparent px-3 py-[7px] text-left text-sm transition-colors duration-100",
                  currentConversation?.id === conversation.id && activeView === "chat"
                    ? "bg-foreground/[0.08] text-foreground shadow-[0_1px_2px_0_rgba(0,0,0,0.05)]"
                    : "text-foreground/70 hover:bg-foreground/[0.04] hover:text-foreground",
                )}
              >
                <span className="truncate">{conversation.title}</span>
              </button>
            ))}

            {filteredConversations.length === 0 && (
              <div className="rounded-xl border border-dashed border-border/60 px-3 py-6 text-center text-sm text-muted-foreground">
                暂无会话
              </div>
            )}
          </div>
        </ScrollArea>
      </div>

      {error && (
        <div className="px-3 pb-3">
          <div className="rounded-xl border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
            {error}
          </div>
        </div>
      )}

      <div className="border-t border-border/50 px-2 pt-3 pb-5">
        <div className="flex h-[56px] items-center justify-center">
          <button
            type="button"
            aria-label="Settings"
            title="Settings"
            onClick={() => setActiveView("settings")}
            className={cn(
              "inline-flex h-10 w-10 items-center justify-center rounded-xl transition-colors",
              activeView === "settings"
                ? "bg-foreground/[0.08] text-foreground"
                : "text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground",
            )}
          >
            <Settings size={18} />
          </button>
        </div>
      </div>
    </div>
  );
}
