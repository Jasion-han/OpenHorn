import {
  ChevronDown,
  ChevronRight,
  LogOut,
  MoreHorizontal,
  Pencil,
  Pin,
  Plus,
  Settings,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  Badge,
  Button,
  cn,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Input,
  ScrollArea,
} from "ui";
import { getDesktopBackendBase } from "../../lib/backendBase";
import {
  hideNotification,
  notifyError,
  notifyErrorOnce,
  notifySuccess,
} from "../../lib/notify";
import { getGlobalDefaultChannel } from "../../lib/defaultChannel";
import { useAuthStore } from "../../stores/authStore";
import { BACKEND_UP_EVENT, useBackendStatusStore } from "../../stores/backendStatusStore";
import { useChatStore } from "../../stores/chatStore";
import { useDesktopShellStore } from "../../stores/desktopShellStore";
import type { Conversation } from "../../types/chat";

type DateGroup = "今天" | "昨天" | "更早";

function formatNewConversationTitle() {
  const date = new Date();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const min = String(date.getMinutes()).padStart(2, "0");
  return `新会话 ${mm}-${dd} ${hh}:${min}`;
}

function groupByCreatedAt(
  items: Conversation[],
): Array<{ label: DateGroup; items: Conversation[] }> {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const yesterdayStart = todayStart - 86_400_000;

  const today: Conversation[] = [];
  const yesterday: Conversation[] = [];
  const earlier: Conversation[] = [];

  for (const item of items) {
    const ts = item.createdAt.getTime();
    if (ts >= todayStart) today.push(item);
    else if (ts >= yesterdayStart) yesterday.push(item);
    else earlier.push(item);
  }

  const desc = (a: Conversation, b: Conversation) => b.createdAt.getTime() - a.createdAt.getTime();
  const groups: Array<{ label: DateGroup; items: Conversation[] }> = [];
  if (today.length) groups.push({ label: "今天", items: today.sort(desc) });
  if (yesterday.length) groups.push({ label: "昨天", items: yesterday.sort(desc) });
  if (earlier.length) groups.push({ label: "更早", items: earlier.sort(desc) });
  return groups;
}

function ConversationRow({
  conversation,
  isActive,
  onSelect,
  onRename,
  onTogglePin,
  onDelete,
  pinLabel,
}: {
  conversation: Conversation;
  isActive: boolean;
  onSelect: () => void;
  onRename: () => void;
  onTogglePin: () => void;
  onDelete: () => void;
  pinLabel: string;
}) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: cannot use <button> due to nested interactive menu controls
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect();
        }
      }}
      className={cn(
        "group flex cursor-pointer items-center justify-between rounded-[10px] border border-transparent px-3 py-[7px] text-left text-sm transition-colors duration-100 titlebar-no-drag",
        isActive
          ? "bg-foreground/[0.08] text-foreground shadow-[0_1px_2px_0_rgba(0,0,0,0.05)]"
          : "text-foreground/70 hover:bg-foreground/[0.04] hover:text-foreground",
      )}
    >
      <span className="min-w-0 flex-1 truncate">{conversation.title}</span>
      <DropdownMenu>
        <DropdownMenuTrigger asChild onClick={(event) => event.stopPropagation()}>
          <Button
            variant="ghost"
            size="icon-sm"
            className="h-6 w-6 shrink-0 opacity-0 group-hover:opacity-100"
          >
            <MoreHorizontal size={13} />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-36">
          <DropdownMenuItem
            onClick={(event) => {
              event.stopPropagation();
              onRename();
            }}
          >
            <Pencil size={14} />
            重命名
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={(event) => {
              event.stopPropagation();
              onTogglePin();
            }}
          >
            <Pin size={14} />
            {pinLabel}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            className="text-destructive focus:text-destructive"
            onClick={(event) => {
              event.stopPropagation();
              window.setTimeout(() => onDelete(), 0);
            }}
          >
            <Trash2 size={14} />
            删除
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

export function DesktopLeftSidebar() {
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [pinnedOpen, setPinnedOpen] = useState(true);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [pendingDelete, setPendingDelete] = useState<Conversation | null>(null);

  const activeView = useDesktopShellStore((state) => state.activeView);
  const setActiveView = useDesktopShellStore((state) => state.setActiveView);
  const openSettings = useDesktopShellStore((state) => state.openSettings);
  const user = useAuthStore((state) => state.user);
  const logout = useAuthStore((state) => state.logout);
  const backend = useBackendStatusStore();
  const [retrying, setRetrying] = useState(false);

  const conversations = useChatStore((state) => state.conversations);
  const currentConversation = useChatStore((state) => state.currentConversation);
  const loadChannels = useChatStore((state) => state.loadChannels);
  const loadConversations = useChatStore((state) => state.loadConversations);
  const createConversation = useChatStore((state) => state.createConversation);
  const selectConversation = useChatStore((state) => state.selectConversation);
  const updateConversation = useChatStore((state) => state.updateConversation);
  const deleteConversation = useChatStore((state) => state.deleteConversation);
  const reset = useChatStore((state) => state.reset);
  const backendBase = getDesktopBackendBase();

  useEffect(() => {
    void Promise.allSettled([loadChannels(), loadConversations()]);
  }, [loadChannels, loadConversations]);

  useEffect(() => {
    const onUp = () => {
      void Promise.allSettled([loadChannels(), loadConversations()]);
    };
    window.addEventListener(BACKEND_UP_EVENT, onUp);
    return () => window.removeEventListener(BACKEND_UP_EVENT, onUp);
  }, [loadChannels, loadConversations]);

  const filteredConversations = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) return conversations;
    return conversations.filter((conversation) =>
      conversation.title.toLowerCase().includes(normalizedQuery),
    );
  }, [conversations, query]);

  const handleCreateConversation = async () => {
    if (useChatStore.getState().isStreaming) return;
    const state = useChatStore.getState();
    const currentConv = state.currentConversation;
    if (currentConv && /^新会话 \d{2}-\d{2} \d{2}:\d{2}$/.test(currentConv.title)) {
      const hasMessages = state.messages.some(
        (m) => m.conversationId === currentConv.id && !m.id.startsWith("draft-"),
      );
      if (!hasMessages) return;
    }
    setCreating(true);
    try {
      const defaultChannel = getGlobalDefaultChannel(useChatStore.getState().channels);
      await createConversation(formatNewConversationTitle(), {
        channelId: defaultChannel?.channelId ?? null,
        modelId: defaultChannel?.modelId ?? null,
      });
      setActiveView("chat");
      notifySuccess("已创建", "新会话已创建");
    } catch (error) {
      notifyError("创建失败", error instanceof Error ? error.message : "无法创建会话");
    } finally {
      setCreating(false);
    }
  };

  const handleDeleteConversation = async (conversation: Conversation) => {
    try {
      await deleteConversation(conversation.id);
      notifySuccess("已删除", "会话已删除");
    } catch (error) {
      notifyError("删除失败", error instanceof Error ? error.message : "无法删除会话");
    }
  };

  const handleTogglePin = async (conversation: Conversation) => {
    try {
      await updateConversation(conversation.id, { isPinned: !conversation.isPinned });
    } catch {
      // store 已记录 error
    }
  };

  const handleSubmitRename = async (conversation: Conversation) => {
    const nextTitle = renameValue.trim();
    setRenamingId(null);
    if (!nextTitle || nextTitle === conversation.title) return;

    try {
      await updateConversation(conversation.id, { title: nextTitle });
      notifySuccess("已保存", "标题已更新");
    } catch (error) {
      notifyError("保存失败", error instanceof Error ? error.message : "无法更新标题");
      void loadConversations();
    }
  };

  const handleLogout = async () => {
    try {
      await logout();
    } finally {
      reset();
      setActiveView("chat");
    }
  };

  const handleRetry = async () => {
    if (retrying) return;
    setRetrying(true);
    try {
      const ok = await backend.retry();
      if (ok) {
        hideNotification("backend_down");
        notifySuccess("连接已恢复", "已重新连接后端");
        return;
      }
      const hint =
        backend.lastError === "Blocked by browser (CORS?)"
          ? "仍然无法访问后端（可能被浏览器跨域/CORS 拦截）。请检查后端 CORS 是否允许当前页面 Origin，并查看 DevTools Console/Network。"
          : backend.lastError === "Blocked by browser (mixed content)"
            ? "仍然无法访问后端（可能被浏览器 Mixed Content 拦截：HTTPS 页面访问 HTTP 后端）。"
            : `仍然无法连接到后端服务（${backendBase}）。`;
      notifyErrorOnce("backend_down", "后端不可用", hint);
    } finally {
      setRetrying(false);
    }
  };

  const pinned = filteredConversations.filter((conversation) => conversation.isPinned);
  const rest = filteredConversations.filter((conversation) => !conversation.isPinned);
  const groups = groupByCreatedAt(rest);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between border-b border-border/50 px-3 py-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold leading-5">OpenHorn</div>
          <div className="flex items-center gap-2">
            {backend.status === "down" && <Badge variant="destructive">offline</Badge>}
            {backend.status === "down" && (
              <Button
                size="sm"
                variant="outline"
                className="h-6 px-2 text-xs"
                onClick={() => void handleRetry()}
                disabled={retrying}
              >
                {retrying ? "Retrying…" : "Retry"}
              </Button>
            )}
          </div>
        </div>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className="flex w-auto items-center gap-1 px-2 titlebar-no-drag"
            >
              <div className="flex h-7 w-7 items-center justify-center rounded-full bg-muted text-xs font-semibold">
                {user?.username?.slice(0, 1)?.toUpperCase() || "U"}
              </div>
              <ChevronDown size={14} />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            <DropdownMenuLabel>{user?.username || "User"}</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="text-destructive focus:text-destructive"
              onClick={() => void handleLogout()}
            >
              <LogOut size={16} />
              退出登录
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden">
        <div className="flex h-full flex-col gap-2 p-2">
          <Button
            className="w-full"
            onClick={() => void handleCreateConversation()}
            disabled={creating}
          >
            <Plus size={16} />
            新会话
          </Button>

          <Input
            placeholder="搜索会话..."
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />

          <ScrollArea className="flex-1 min-h-0">
            <div className="flex flex-col gap-1 py-1">
              {pinned.length > 0 && (
                <div>
                  <div className="flex items-center justify-between px-2 py-1">
                    <span className="text-xs font-semibold text-muted-foreground">置顶</span>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="h-5 w-5"
                      onClick={() => setPinnedOpen((value) => !value)}
                    >
                      {pinnedOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                    </Button>
                  </div>

                  {pinnedOpen &&
                    pinned.map((conversation) =>
                      renamingId === conversation.id ? (
                        <div key={conversation.id} className="px-2 py-1">
                          <Input
                            autoFocus
                            value={renameValue}
                            onChange={(event) => setRenameValue(event.target.value)}
                            onBlur={() => void handleSubmitRename(conversation)}
                            onKeyDown={(event) => {
                              if (event.key === "Enter") void handleSubmitRename(conversation);
                              if (event.key === "Escape") setRenamingId(null);
                            }}
                          />
                        </div>
                      ) : (
                        <ConversationRow
                          key={`pinned-${conversation.id}`}
                          conversation={conversation}
                          isActive={currentConversation?.id === conversation.id}
                          onSelect={() => {
                            setActiveView("chat");
                            void selectConversation(conversation.id);
                          }}
                          onRename={() => {
                            setRenamingId(conversation.id);
                            setRenameValue(conversation.title);
                          }}
                          onTogglePin={() => void handleTogglePin(conversation)}
                          onDelete={() => setPendingDelete(conversation)}
                          pinLabel="取消置顶"
                        />
                      ),
                    )}
                </div>
              )}

              {groups.map((group) => (
                <div key={group.label}>
                  <p className="px-2 py-1 text-xs font-semibold text-muted-foreground">
                    {group.label}
                  </p>
                  {group.items.map((conversation) =>
                    renamingId === conversation.id ? (
                      <div key={conversation.id} className="px-2 py-1">
                        <Input
                          autoFocus
                          value={renameValue}
                          onChange={(event) => setRenameValue(event.target.value)}
                          onBlur={() => void handleSubmitRename(conversation)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") void handleSubmitRename(conversation);
                            if (event.key === "Escape") setRenamingId(null);
                          }}
                        />
                      </div>
                    ) : (
                      <ConversationRow
                        key={conversation.id}
                        conversation={conversation}
                        isActive={currentConversation?.id === conversation.id}
                        onSelect={() => {
                          setActiveView("chat");
                          void selectConversation(conversation.id);
                        }}
                        onRename={() => {
                          setRenamingId(conversation.id);
                          setRenameValue(conversation.title);
                        }}
                        onTogglePin={() => void handleTogglePin(conversation)}
                        onDelete={() => setPendingDelete(conversation)}
                        pinLabel="置顶"
                      />
                    ),
                  )}
                </div>
              ))}

              {filteredConversations.length === 0 && (
                <p className="py-8 text-center text-xs text-muted-foreground">暂无会话</p>
              )}
            </div>
          </ScrollArea>
        </div>
      </div>

      <div className="border-t border-border/50 px-2 pt-3 pb-5">
        <div className="flex h-[56px] items-center justify-center">
          <button
            type="button"
            aria-label="Settings"
            title="Settings"
            onClick={() => openSettings("channels")}
            className={cn(
              "titlebar-no-drag inline-flex h-10 w-10 items-center justify-center rounded-xl transition-colors",
              activeView === "settings"
                ? "bg-foreground/[0.08] text-foreground"
                : "text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground",
            )}
          >
            <Settings size={18} />
          </button>
        </div>
      </div>

      <Dialog
        open={Boolean(pendingDelete)}
        onOpenChange={(open) => !open && setPendingDelete(null)}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>删除对话？</DialogTitle>
            <DialogDescription>确定删除该会话？此操作不可恢复。</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setPendingDelete(null)}>
              取消
            </Button>
            <Button
              ref={(el) => { queueMicrotask(() => el?.focus()); }}
              variant="destructive"
              onClick={() => {
                const target = pendingDelete;
                setPendingDelete(null);
                if (target) {
                  void handleDeleteConversation(target);
                }
              }}
            >
              删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
