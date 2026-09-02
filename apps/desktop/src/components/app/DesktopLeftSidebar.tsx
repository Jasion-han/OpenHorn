import {
  AlarmClock,
  BookOpen,
  ChevronDown,
  ChevronRight,
  Clock,
  MoreHorizontal,
  PanelLeftClose,
  Pencil,
  Pin,
  Plus,
  Search,
  Settings,
  Trash2,
} from "lucide-react";
import { memo, useEffect, useMemo, useState } from "react";
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
import { useClockTick } from "../../hooks/useClockTick";
import { getDesktopBackendBase } from "../../lib/backendBase";
import { displayConversationTitle } from "../../lib/conversationTitle";
import { formatSidebarLabel, getSidebarLabel, type SidebarLabelKey } from "../../lib/i18n/agent";
import { hideNotification, notifyError, notifyErrorOnce, notifySuccess } from "../../lib/notify";
import { useAuthStore } from "../../stores/authStore";
import { useBackendStatusStore } from "../../stores/backendStatusStore";
import { useChatStore } from "../../stores/chatStore";
import { useDesktopShellStore } from "../../stores/desktopShellStore";
import { useScheduledTaskStore } from "../../stores/scheduledTaskStore";
import type { Conversation, MessageSearchResult } from "../../types/chat";

// The shortcut hint next to the new-conversation button. The handler accepts both
// modifiers, so the label follows the platform instead of always showing ⌘.
const NEW_CONVERSATION_SHORTCUT_LABEL =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘ N" : "Ctrl N";

type DateGroupKey = Extract<
  SidebarLabelKey,
  "sidebar.group.today" | "sidebar.group.yesterday" | "sidebar.group.earlier"
>;

// `now` is a parameter rather than a `new Date()` inside, so the caller is forced
// to supply a reading that re-renders when the day turns — and so the boundary
// arithmetic, which is where the off-by-one lives, is testable without a clock.
export function groupByCreatedAt(
  items: Conversation[],
  now: Date,
): Array<{ label: DateGroupKey; items: Conversation[] }> {
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  // Calendar arithmetic, not minus-24-hours: on a DST day the previous midnight
  // is 23 or 25 hours back, and a fixed offset would put an hour of yesterday
  // into "earlier".
  const yesterdayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).getTime();

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
  const groups: Array<{ label: DateGroupKey; items: Conversation[] }> = [];
  if (today.length) groups.push({ label: "sidebar.group.today", items: today.sort(desc) });
  if (yesterday.length)
    groups.push({ label: "sidebar.group.yesterday", items: yesterday.sort(desc) });
  if (earlier.length) groups.push({ label: "sidebar.group.earlier", items: earlier.sort(desc) });
  return groups;
}

// Memoized: switching conversations changes `currentConversation`, which re-renders
// the sidebar. Without this, every row (each mounting a Radix DropdownMenu) would
// re-render — the dominant cost of a conversation switch. The comparator ignores the
// callback props (they behave identically for a given conversation) and only reacts
// to the fields that actually change what a row renders.
const ConversationRow = memo(
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
        <span className="min-w-0 flex-1 truncate">
          {displayConversationTitle(conversation.title)}
        </span>
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
              {getSidebarLabel("sidebar.action.rename")}
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
              {getSidebarLabel("sidebar.action.delete")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    );
  },
  (prev, next) =>
    prev.isActive === next.isActive &&
    prev.pinLabel === next.pinLabel &&
    prev.conversation.id === next.conversation.id &&
    prev.conversation.title === next.conversation.title &&
    prev.conversation.isPinned === next.conversation.isPinned,
);

export function DesktopLeftSidebar() {
  // Regroups when the day turns. Without it a window left open overnight keeps
  // labelling yesterday's conversations "today" until some unrelated interaction
  // happens to re-render the list.
  const today = useClockTick("day");
  const [query, setQuery] = useState("");
  // The search field is collapsed behind an icon (Qoder-style) so the resting
  // sidebar is just "new conversation + the list".
  const [searchOpen, setSearchOpen] = useState(false);
  const [pinnedOpen, setPinnedOpen] = useState(true);
  const [taskGroupsOpen, setTaskGroupsOpen] = useState<Record<string, boolean>>({});
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [pendingDelete, setPendingDelete] = useState<Conversation | null>(null);

  const activeView = useDesktopShellStore((state) => state.activeView);
  const setActiveView = useDesktopShellStore((state) => state.setActiveView);
  const setSidebarCollapsed = useDesktopShellStore((state) => state.setSidebarCollapsed);
  const openSettings = useDesktopShellStore((state) => state.openSettings);
  const openScheduledTasks = useDesktopShellStore((state) => state.openScheduledTasks);
  const openRunDetail = useDesktopShellStore((state) => state.openRunDetail);
  const user = useAuthStore((state) => state.user);
  const backendStatus = useBackendStatusStore((state) => state.status);
  const backendLastError = useBackendStatusStore((state) => state.lastError);
  const backendRetry = useBackendStatusStore((state) => state.retry);
  const [retrying, setRetrying] = useState(false);

  const conversations = useChatStore((state) => state.conversations);
  const currentConversation = useChatStore((state) => state.currentConversation);
  const startNewConversation = useChatStore((state) => state.startNewConversation);
  const selectConversation = useChatStore((state) => state.selectConversation);
  const loadConversations = useChatStore((state) => state.loadConversations);
  const updateConversation = useChatStore((state) => state.updateConversation);
  const deleteConversation = useChatStore((state) => state.deleteConversation);
  const searchMessages = useChatStore((state) => state.searchMessages);
  const reset = useChatStore((state) => state.reset);
  const backendBase = getDesktopBackendBase();
  const recentRuns = useScheduledTaskStore((state) => state.runs);
  const loadRuns = useScheduledTaskStore((state) => state.loadRuns);

  const [searchResults, setSearchResults] = useState<MessageSearchResult[] | null>(null);

  useEffect(() => {
    void loadRuns();
    const timer = setInterval(() => void loadRuns(), 30_000);
    return () => clearInterval(timer);
  }, [loadRuns]);

  // ⌘N / Ctrl+N — the shortcut advertised next to the new-conversation button.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== "n" || !(event.metaKey || event.ctrlKey) || event.shiftKey) {
        return;
      }
      event.preventDefault();
      handleCreateConversation();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  // Debounced full-text search via backend FTS5 API. When the query is empty,
  // searchResults is set to null so the sidebar falls back to the normal
  // conversation list with client-side title filtering.
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setSearchResults(null);
      return;
    }
    const timer = setTimeout(async () => {
      try {
        const results = await searchMessages(q);
        setSearchResults(results);
      } catch {
        setSearchResults(null);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [query, searchMessages]);

  const scheduledConversationIds = useMemo(() => {
    const ids = new Set<string>();
    for (const run of recentRuns) {
      if (run.conversationId) ids.add(run.conversationId);
    }
    return ids;
  }, [recentRuns]);

  const filteredConversations = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    const base = conversations.filter((c) => !scheduledConversationIds.has(c.id));
    if (!normalizedQuery) return base;
    return base.filter((conversation) =>
      conversation.title.toLowerCase().includes(normalizedQuery),
    );
  }, [conversations, query, scheduledConversationIds]);

  // Opens the welcome screen rather than creating a row up front — the
  // conversation is created by the first message that is actually sent.
  const handleCreateConversation = () => {
    startNewConversation();
    setActiveView("chat");
  };

  const handleDeleteConversation = async (conversation: Conversation) => {
    try {
      await deleteConversation(conversation.id);
      notifySuccess(
        getSidebarLabel("sidebar.notify.deletedTitle"),
        getSidebarLabel("sidebar.notify.deletedBody"),
      );
    } catch (error) {
      notifyError(
        getSidebarLabel("sidebar.notify.deleteFailedTitle"),
        error instanceof Error ? error.message : getSidebarLabel("sidebar.notify.deleteFailedBody"),
      );
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
      notifySuccess(
        getSidebarLabel("sidebar.notify.savedTitle"),
        getSidebarLabel("sidebar.notify.savedBody"),
      );
    } catch (error) {
      notifyError(
        getSidebarLabel("sidebar.notify.saveFailedTitle"),
        error instanceof Error ? error.message : getSidebarLabel("sidebar.notify.saveFailedBody"),
      );
      void useChatStore.getState().loadConversations();
    }
  };

  const handleRetry = async () => {
    if (retrying) return;
    setRetrying(true);
    try {
      const ok = await backendRetry();
      if (ok) {
        hideNotification("backend_down");
        notifySuccess(
          getSidebarLabel("sidebar.notify.reconnectedTitle"),
          getSidebarLabel("sidebar.notify.reconnectedBody"),
        );
        return;
      }
      const hint =
        backendLastError === "Blocked by browser (CORS?)"
          ? getSidebarLabel("sidebar.notify.backendDownCors")
          : backendLastError === "Blocked by browser (mixed content)"
            ? getSidebarLabel("sidebar.notify.backendDownMixedContent")
            : formatSidebarLabel("sidebar.notify.backendDownGeneric", { base: backendBase });
      notifyErrorOnce("backend_down", getSidebarLabel("sidebar.notify.backendDownTitle"), hint);
    } finally {
      setRetrying(false);
    }
  };

  const pinned = filteredConversations.filter((conversation) => conversation.isPinned);
  const rest = filteredConversations.filter((conversation) => !conversation.isPinned);
  const groups = groupByCreatedAt(rest, today);

  const taskGroups = useMemo(() => {
    const map = new Map<string, { taskTitle: string; runs: typeof recentRuns }>();
    for (const run of recentRuns) {
      const key = run.taskId;
      const existing = map.get(key);
      if (existing) {
        existing.runs.push(run);
      } else {
        map.set(key, { taskTitle: run.taskTitle ?? run.taskId.slice(0, 8), runs: [run] });
      }
    }
    return Array.from(map.entries());
  }, [recentRuns]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Also the window's drag handle under the macOS overlay title bar — there
          is no native bar left to grab. Tauri only starts a drag when the event
          target itself carries the attribute, so the buttons stay clickable. */}
      <div
        data-tauri-drag-region
        className="titlebar-traffic-light-inset flex items-center justify-between gap-1 px-2 pb-2 pt-2"
      >
        <Button
          variant="ghost"
          size="icon-sm"
          className="titlebar-no-drag"
          aria-label={getSidebarLabel("sidebar.collapse")}
          title={getSidebarLabel("sidebar.collapse")}
          onClick={() => setSidebarCollapsed(true)}
        >
          <PanelLeftClose size={17} />
        </Button>

        <div className="flex min-w-0 items-center gap-1">
          {backendStatus === "down" && (
            <>
              <Badge variant="destructive">offline</Badge>
              <Button
                size="sm"
                variant="outline"
                className="h-6 px-2 text-xs"
                onClick={() => void handleRetry()}
                disabled={retrying}
              >
                {retrying ? "Retrying…" : "Retry"}
              </Button>
            </>
          )}
          <Button
            variant="ghost"
            size="icon-sm"
            className="titlebar-no-drag"
            aria-label={getSidebarLabel("sidebar.searchToggle")}
            title={getSidebarLabel("sidebar.searchToggle")}
            onClick={() => {
              setSearchOpen(!searchOpen);
              setQuery("");
            }}
          >
            <Search size={17} />
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden">
        <div className="flex h-full flex-col gap-2 px-2 pb-2">
          <Button
            variant="outline"
            className="w-full justify-start gap-2 px-3 titlebar-no-drag"
            onClick={handleCreateConversation}
          >
            <Plus size={16} />
            <span className="flex-1 text-left">{getSidebarLabel("sidebar.newConversation")}</span>
            <kbd className="font-sans text-xs font-normal tracking-wide text-muted-foreground/70">
              {NEW_CONVERSATION_SHORTCUT_LABEL}
            </kbd>
          </Button>

          <div className="flex flex-col gap-0.5">
            <button
              type="button"
              className={cn(
                "flex items-center gap-2 rounded-[10px] px-3 py-[7px] text-left text-sm transition-colors duration-100 titlebar-no-drag",
                activeView === "scheduled-tasks"
                  ? "bg-foreground/[0.08] text-foreground"
                  : "text-foreground/70 hover:bg-foreground/[0.04] hover:text-foreground",
              )}
              onClick={() => openScheduledTasks("tasks")}
            >
              <AlarmClock size={15} className="shrink-0 text-muted-foreground" />
              {getSidebarLabel("sidebar.scheduledTasks")}
            </button>
            <button
              type="button"
              className="flex items-center gap-2 rounded-[10px] px-3 py-[7px] text-left text-sm text-foreground/70 transition-colors duration-100 titlebar-no-drag hover:bg-foreground/[0.04] hover:text-foreground"
              onClick={() =>
                notifySuccess(
                  getSidebarLabel("sidebar.knowledgeBase"),
                  getSidebarLabel("sidebar.comingSoon"),
                )
              }
            >
              <BookOpen size={15} className="shrink-0 text-muted-foreground" />
              {getSidebarLabel("sidebar.knowledgeBase")}
            </button>
          </div>

          {searchOpen && (
            <Input
              autoFocus
              placeholder={getSidebarLabel("sidebar.searchPlaceholder")}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  setQuery("");
                  setSearchOpen(false);
                }
              }}
            />
          )}

          <ScrollArea className="flex-1 min-h-0">
            <div className="flex flex-col gap-1 py-1">
              {searchResults !== null ? (
                searchResults.length > 0 ? (
                  searchResults.map((result) => (
                    // biome-ignore lint/a11y/useSemanticElements: cannot use <button> due to multi-line content layout
                    <div
                      key={result.messageId}
                      role="button"
                      tabIndex={0}
                      onClick={() => {
                        setActiveView("chat");
                        void selectConversation(result.conversationId);
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          setActiveView("chat");
                          void selectConversation(result.conversationId);
                        }
                      }}
                      className="flex cursor-pointer flex-col gap-0.5 rounded-[10px] border border-transparent px-3 py-[7px] text-left text-sm transition-colors duration-100 titlebar-no-drag text-foreground/70 hover:bg-foreground/[0.04] hover:text-foreground"
                    >
                      <span className="truncate font-medium text-foreground">
                        {displayConversationTitle(result.conversationTitle)}
                      </span>
                      <span className="line-clamp-2 text-xs text-muted-foreground">
                        {result.snippet.length > 100
                          ? `${result.snippet.slice(0, 100)}...`
                          : result.snippet}
                      </span>
                    </div>
                  ))
                ) : (
                  <p className="py-8 text-center text-xs text-muted-foreground">
                    {getSidebarLabel("sidebar.searchNoResults")}
                  </p>
                )
              ) : (
                <>
                  {pinned.length > 0 && (
                    <div>
                      <div className="flex items-center justify-between px-3 pb-1 pt-2">
                        <span className="text-[11px] font-medium text-muted-foreground/80">
                          {getSidebarLabel("sidebar.pinnedHeading")}
                        </span>
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
                                setRenameValue(displayConversationTitle(conversation.title));
                              }}
                              onTogglePin={() => void handleTogglePin(conversation)}
                              onDelete={() => setPendingDelete(conversation)}
                              pinLabel={getSidebarLabel("sidebar.action.unpin")}
                            />
                          ),
                        )}
                    </div>
                  )}

                  {taskGroups.map(([taskId, { taskTitle, runs }]) => (
                    <div key={`task-${taskId}`}>
                      <button
                        type="button"
                        className="flex w-full cursor-pointer items-center gap-1 px-3 pb-1 pt-2 text-left"
                        onClick={() =>
                          setTaskGroupsOpen((prev) => ({
                            ...prev,
                            [taskId]: !(prev[taskId] ?? false),
                          }))
                        }
                      >
                        {(taskGroupsOpen[taskId] ?? false) ? (
                          <ChevronDown size={11} className="shrink-0 text-muted-foreground/60" />
                        ) : (
                          <ChevronRight size={11} className="shrink-0 text-muted-foreground/60" />
                        )}
                        <span className="text-[11px] font-medium text-muted-foreground/80">
                          {taskTitle}
                        </span>
                      </button>
                      {(taskGroupsOpen[taskId] ?? false) &&
                        runs.map((run) => (
                          <div
                            key={run.id}
                            role="button"
                            tabIndex={0}
                            onClick={() => {
                              if (run.conversationId) {
                                void loadConversations().then(() => {
                                  void selectConversation(run.conversationId!);
                                  setActiveView("chat");
                                });
                              } else {
                                openScheduledTasks("runs");
                              }
                            }}
                            onKeyDown={(event) => {
                              if (event.key === "Enter" || event.key === " ") {
                                event.preventDefault();
                                if (run.conversationId) {
                                  void loadConversations().then(() => {
                                    void selectConversation(run.conversationId!);
                                    setActiveView("chat");
                                  });
                                } else {
                                  openScheduledTasks("runs");
                                }
                              }
                            }}
                            className="flex cursor-pointer items-center gap-2 rounded-[10px] px-3 py-[7px] text-left text-sm text-foreground/70 transition-colors duration-100 titlebar-no-drag hover:bg-foreground/[0.04] hover:text-foreground"
                          >
                            <Clock size={14} className="shrink-0 text-muted-foreground" />
                            <span className="min-w-0 flex-1 truncate text-xs">
                              {run.startedAt
                                ? new Date(run.startedAt).toLocaleString("zh-CN", {
                                    month: "2-digit",
                                    day: "2-digit",
                                    hour: "2-digit",
                                    minute: "2-digit",
                                  })
                                : run.id.slice(0, 8)}
                            </span>
                            <span
                              className={cn(
                                "h-2 w-2 shrink-0 rounded-full",
                                run.status === "completed" && "bg-emerald-500",
                                run.status === "failed" && "bg-red-500",
                                // pending（到点刚建、桌面端尚未认领的一瞬）也算执行中，
                                // 统一蓝色脉冲，一到点就是蓝点，不闪一下灰。
                                (run.status === "running" || run.status === "pending") &&
                                  "bg-blue-500 animate-pulse",
                              )}
                            />
                          </div>
                        ))}
                    </div>
                  ))}

                  {groups.map((group) => (
                    <div key={group.label}>
                      <p className="px-3 pb-1 pt-2 text-[11px] font-medium text-muted-foreground/80">
                        {getSidebarLabel(group.label)}
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
                              setRenameValue(displayConversationTitle(conversation.title));
                            }}
                            onTogglePin={() => void handleTogglePin(conversation)}
                            onDelete={() => setPendingDelete(conversation)}
                            pinLabel={getSidebarLabel("sidebar.action.pin")}
                          />
                        ),
                      )}
                    </div>
                  ))}

                  {filteredConversations.length === 0 && (
                    <p className="py-8 text-center text-xs text-muted-foreground">
                      {getSidebarLabel("sidebar.emptyState")}
                    </p>
                  )}
                </>
              )}
            </div>
          </ScrollArea>
        </div>
      </div>

      <div className="flex items-center gap-1 border-t border-border/50 px-2 py-2">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="titlebar-no-drag flex min-w-0 flex-1 items-center gap-2 rounded-[10px] px-1.5 py-1.5 text-left transition-colors hover:bg-foreground/[0.04]"
            >
              <div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold">
                {user?.username?.slice(0, 1)?.toUpperCase() || "U"}
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] font-medium leading-4">
                  {user?.username || "User"}
                </div>
                {user?.email && !user.email.endsWith("@openhorn.local") && (
                  <div className="truncate text-[11px] leading-4 text-muted-foreground">
                    {user.email}
                  </div>
                )}
              </div>
              <ChevronDown size={13} className="shrink-0 text-muted-foreground" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" side="top" className="w-44">
            <DropdownMenuLabel>{user?.username || "User"}</DropdownMenuLabel>
          </DropdownMenuContent>
        </DropdownMenu>

        <button
          type="button"
          aria-label={getSidebarLabel("sidebar.settings")}
          title={getSidebarLabel("sidebar.settings")}
          onClick={() => openSettings("channels")}
          className={cn(
            "titlebar-no-drag inline-flex size-8 shrink-0 items-center justify-center rounded-[10px] transition-colors",
            activeView === "settings"
              ? "bg-foreground/[0.08] text-foreground"
              : "text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground",
          )}
        >
          <Settings size={17} />
        </button>
      </div>

      <Dialog
        open={Boolean(pendingDelete)}
        onOpenChange={(open) => !open && setPendingDelete(null)}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{getSidebarLabel("sidebar.deleteDialog.title")}</DialogTitle>
            <DialogDescription>
              {getSidebarLabel("sidebar.deleteDialog.description")}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setPendingDelete(null)}>
              {getSidebarLabel("sidebar.deleteDialog.cancel")}
            </Button>
            <Button
              ref={(el) => {
                queueMicrotask(() => el?.focus());
              }}
              variant="destructive"
              onClick={() => {
                const target = pendingDelete;
                setPendingDelete(null);
                if (target) {
                  void handleDeleteConversation(target);
                }
              }}
            >
              {getSidebarLabel("sidebar.deleteDialog.confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
