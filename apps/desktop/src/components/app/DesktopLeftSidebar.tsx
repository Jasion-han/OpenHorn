import {
  AlarmClock,
  BookOpen,
  ChevronDown,
  ChevronRight,
  Clock,
  Folder,
  FolderInput,
  FolderPlus,
  MoreHorizontal,
  PanelLeftClose,
  Pencil,
  Pin,
  Plus,
  Search,
  Settings,
  Star,
  Trash2,
} from "lucide-react";
import { memo, useEffect, useMemo, useState } from "react";
import type { Project } from "shared/types";
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
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
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
import { useProjectStore } from "../../stores/projectStore";
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

/** How many of a project's conversations show before "load more" takes over. */
export const PROJECT_PAGE_SIZE = 10;
/** How many more rows each "load more" click reveals. */
export const PROJECT_PAGE_STEP = 20;

/**
 * Splits conversations into the plain list and per-project buckets. A
 * conversation whose project is not in `projects` (removed elsewhere, or the
 * project list failed to load) falls back to the plain list rather than
 * disappearing. Project buckets are ordered by last activity, newest first —
 * a project is a working folder, so "what did I do here last" matters more
 * than creation date.
 */
export function partitionByProject(
  items: Conversation[],
  projects: Project[],
): { plain: Conversation[]; byProject: Map<string, Conversation[]> } {
  const byProject = new Map<string, Conversation[]>();
  for (const project of projects) byProject.set(project.id, []);
  const plain: Conversation[] = [];
  for (const item of items) {
    const bucket = item.projectId ? byProject.get(item.projectId) : undefined;
    if (bucket) bucket.push(item);
    else plain.push(item);
  }
  const byUpdatedDesc = (a: Conversation, b: Conversation) =>
    b.updatedAt.getTime() - a.updatedAt.getTime();
  for (const bucket of byProject.values()) bucket.sort(byUpdatedDesc);
  return { plain, byProject };
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
    isRunning,
    projects,
    indent,
    onSelect,
    onRename,
    onTogglePin,
    onMoveToProject,
    onDelete,
    pinLabel,
  }: {
    conversation: Conversation;
    isActive: boolean;
    /** A turn is streaming in this conversation — shown as a pulsing dot. */
    isRunning: boolean;
    /** Targets for the "move to project" submenu (the row's own project is excluded). */
    projects: Project[];
    /** Nested under a project header. */
    indent?: boolean;
    onSelect: () => void;
    onRename: () => void;
    onTogglePin: () => void;
    onMoveToProject: (projectId: string | null) => void;
    onDelete: () => void;
    pinLabel: string;
  }) {
    const moveTargets = projects.filter((project) => project.id !== conversation.projectId);
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
          "group flex cursor-pointer items-center justify-between rounded-[10px] border border-transparent py-[7px] pr-3 text-left text-sm transition-colors duration-100 titlebar-no-drag",
          indent ? "pl-7" : "pl-3",
          isActive
            ? "bg-foreground/[0.08] text-foreground shadow-[0_1px_2px_0_rgba(0,0,0,0.05)]"
            : "text-foreground/70 hover:bg-foreground/[0.04] hover:text-foreground",
        )}
      >
        {isRunning && (
          <span className="mr-2 h-2 w-2 shrink-0 animate-pulse rounded-full bg-blue-500" />
        )}
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
            <DropdownMenuSub>
              <DropdownMenuSubTrigger onClick={(event) => event.stopPropagation()}>
                <FolderInput size={14} />
                {getSidebarLabel("sidebar.action.moveToProject")}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="max-h-72 w-48 overflow-y-auto">
                {moveTargets.length === 0 && !conversation.projectId ? (
                  <DropdownMenuItem disabled>
                    {getSidebarLabel("sidebar.action.noProjects")}
                  </DropdownMenuItem>
                ) : null}
                {moveTargets.map((project) => (
                  <DropdownMenuItem
                    key={project.id}
                    onClick={(event) => {
                      event.stopPropagation();
                      onMoveToProject(project.id);
                    }}
                  >
                    <Folder size={14} />
                    <span className="truncate">{project.name}</span>
                  </DropdownMenuItem>
                ))}
                {conversation.projectId ? (
                  <>
                    {moveTargets.length > 0 && <DropdownMenuSeparator />}
                    <DropdownMenuItem
                      onClick={(event) => {
                        event.stopPropagation();
                        onMoveToProject(null);
                      }}
                    >
                      {getSidebarLabel("sidebar.action.moveOutOfProject")}
                    </DropdownMenuItem>
                  </>
                ) : null}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
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
    prev.isRunning === next.isRunning &&
    prev.indent === next.indent &&
    prev.projects === next.projects &&
    prev.pinLabel === next.pinLabel &&
    prev.conversation.id === next.conversation.id &&
    prev.conversation.title === next.conversation.title &&
    prev.conversation.isPinned === next.conversation.isPinned &&
    (prev.conversation.projectId ?? null) === (next.conversation.projectId ?? null),
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
  const [projectRenamingId, setProjectRenamingId] = useState<string | null>(null);
  const [projectRenameValue, setProjectRenameValue] = useState("");
  const [pendingRemoveProject, setPendingRemoveProject] = useState<Project | null>(null);
  // Rows revealed per project beyond the first page ("load more" is client-side:
  // the conversation list is already fully loaded).
  const [projectVisibleCounts, setProjectVisibleCounts] = useState<Record<string, number>>({});

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
  const isStreaming = useChatStore((state) => state.isStreaming);
  const reset = useChatStore((state) => state.reset);
  const projects = useProjectStore((state) => state.projects);
  const activeProjectId = useProjectStore((state) => state.activeProjectId);
  const projectsExpanded = useProjectStore((state) => state.expanded);
  const loadProjects = useProjectStore((state) => state.loadProjects);
  const addProjectFromPicker = useProjectStore((state) => state.addProjectFromPicker);
  const renameProject = useProjectStore((state) => state.renameProject);
  const toggleProjectStar = useProjectStore((state) => state.toggleStar);
  const removeProject = useProjectStore((state) => state.removeProject);
  const setActiveProject = useProjectStore((state) => state.setActiveProject);
  const setProjectExpanded = useProjectStore((state) => state.setExpanded);
  const toggleProjectExpanded = useProjectStore((state) => state.toggleExpanded);
  const backendBase = getDesktopBackendBase();
  const recentRuns = useScheduledTaskStore((state) => state.runs);
  const loadRuns = useScheduledTaskStore((state) => state.loadRuns);

  const [searchResults, setSearchResults] = useState<MessageSearchResult[] | null>(null);

  useEffect(() => {
    void loadRuns();
    const timer = setInterval(() => void loadRuns(), 30_000);
    return () => clearInterval(timer);
  }, [loadRuns]);

  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

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

  const filteredConversations = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    // A scheduled-task conversation is marked at the data layer (scheduledTaskId)
    // and shown only under its task group — never in the user's chat list. This
    // is robust against the runs window: filtering by the runs list dropped older
    // scheduled conversations back into the chat list once their run scrolled off.
    const base = conversations.filter((c) => !c.scheduledTaskId);
    if (!normalizedQuery) return base;
    return base.filter((conversation) =>
      conversation.title.toLowerCase().includes(normalizedQuery),
    );
  }, [conversations, query]);

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

  const handleMoveToProject = async (conversation: Conversation, projectId: string | null) => {
    if ((conversation.projectId ?? null) === projectId) return;
    try {
      await updateConversation(conversation.id, { projectId });
      if (projectId) setProjectExpanded(projectId, true);
    } catch {
      // store 已记录 error 并回滚
    }
  };

  // Selecting a project makes it the scope for the next conversation and opens
  // the welcome screen, mirroring "new conversation" but inside that folder.
  const handleSelectProject = (project: Project) => {
    setActiveProject(project.id);
    setProjectExpanded(project.id, true);
    startNewConversation();
    setActiveView("chat");
  };

  const handleAddProject = async () => {
    try {
      const project = await addProjectFromPicker();
      if (!project) return;
      notifySuccess(getSidebarLabel("sidebar.project.notify.addedTitle"), project.name);
    } catch (error) {
      notifyError(
        getSidebarLabel("sidebar.project.notify.addFailedTitle"),
        error instanceof Error
          ? error.message
          : getSidebarLabel("sidebar.project.notify.addFailedBody"),
      );
    }
  };

  const handleToggleProjectStar = async (project: Project) => {
    try {
      await toggleProjectStar(project.id);
    } catch (error) {
      notifyError(
        getSidebarLabel("sidebar.project.notify.updateFailedTitle"),
        error instanceof Error ? error.message : "",
      );
    }
  };

  const handleSubmitProjectRename = async (project: Project) => {
    const nextName = projectRenameValue.trim();
    setProjectRenamingId(null);
    if (!nextName || nextName === project.name) return;
    try {
      await renameProject(project.id, nextName);
    } catch (error) {
      notifyError(
        getSidebarLabel("sidebar.project.notify.updateFailedTitle"),
        error instanceof Error ? error.message : "",
      );
    }
  };

  const handleRemoveProject = async (project: Project) => {
    try {
      await removeProject(project.id);
      notifySuccess(getSidebarLabel("sidebar.project.notify.removedTitle"), project.name);
    } catch (error) {
      notifyError(
        getSidebarLabel("sidebar.project.notify.removeFailedTitle"),
        error instanceof Error ? error.message : "",
      );
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

  const { plain, byProject } = useMemo(
    () => partitionByProject(filteredConversations, projects),
    [filteredConversations, projects],
  );
  const pinned = plain.filter((conversation) => conversation.isPinned);
  const rest = plain.filter((conversation) => !conversation.isPinned);
  const groups = groupByCreatedAt(rest, today);

  // One place decides how a conversation row renders (inline rename vs. row), so
  // the plain, pinned and project lists cannot drift apart in menu items.
  const renderConversation = (conversation: Conversation, indent?: boolean) =>
    renamingId === conversation.id ? (
      <div key={conversation.id} className={cn("py-1", indent ? "pl-6 pr-2" : "px-2")}>
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
        isRunning={isStreaming && currentConversation?.id === conversation.id}
        projects={projects}
        indent={indent}
        onSelect={() => {
          setActiveView("chat");
          void selectConversation(conversation.id);
        }}
        onRename={() => {
          setRenamingId(conversation.id);
          setRenameValue(displayConversationTitle(conversation.title));
        }}
        onTogglePin={() => void handleTogglePin(conversation)}
        onMoveToProject={(projectId) => void handleMoveToProject(conversation, projectId)}
        onDelete={() => setPendingDelete(conversation)}
        pinLabel={getSidebarLabel(
          conversation.isPinned ? "sidebar.action.unpin" : "sidebar.action.pin",
        )}
      />
    );

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

                      {pinnedOpen && pinned.map((conversation) => renderConversation(conversation))}
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

                  {/* Projects: local folders, each grouping the conversations filed
                      under it; selecting one scopes the next conversation to it.
                      Placed above the (unbounded) plain list so it stays reachable. */}
                  <div>
                    <div className="flex items-center justify-between px-3 pb-1 pt-3">
                      <span className="text-[11px] font-medium text-muted-foreground/80">
                        {getSidebarLabel("sidebar.projectsHeading")}
                      </span>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        className="h-5 w-5"
                        aria-label={getSidebarLabel("sidebar.project.add")}
                        title={getSidebarLabel("sidebar.project.add")}
                        onClick={() => void handleAddProject()}
                      >
                        <FolderPlus size={13} />
                      </Button>
                    </div>

                    {projects.length === 0 && (
                      <p className="px-3 py-2 text-xs text-muted-foreground/70">
                        {getSidebarLabel("sidebar.project.empty")}
                      </p>
                    )}

                    {projects.map((project) => {
                      const items = byProject.get(project.id) ?? [];
                      const open = projectsExpanded[project.id] ?? false;
                      const visibleCount = projectVisibleCounts[project.id] ?? PROJECT_PAGE_SIZE;
                      const visible = items.slice(0, visibleCount);
                      const remaining = items.length - visible.length;
                      const isScope = activeProjectId === project.id && !currentConversation;
                      return (
                        <div key={`project-${project.id}`}>
                          {projectRenamingId === project.id ? (
                            <div className="px-2 py-1">
                              <Input
                                autoFocus
                                value={projectRenameValue}
                                onChange={(event) => setProjectRenameValue(event.target.value)}
                                onBlur={() => void handleSubmitProjectRename(project)}
                                onKeyDown={(event) => {
                                  if (event.key === "Enter")
                                    void handleSubmitProjectRename(project);
                                  if (event.key === "Escape") setProjectRenamingId(null);
                                }}
                              />
                            </div>
                          ) : (
                            <div
                              className={cn(
                                "group flex items-center gap-1 rounded-[10px] border border-transparent py-[6px] pl-1.5 pr-1 text-sm transition-colors duration-100 titlebar-no-drag",
                                isScope
                                  ? "bg-foreground/[0.08] text-foreground"
                                  : "text-foreground/80 hover:bg-foreground/[0.04] hover:text-foreground",
                              )}
                              title={project.rootPath}
                            >
                              <button
                                type="button"
                                className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground/60 hover:text-foreground"
                                onClick={() => toggleProjectExpanded(project.id)}
                                aria-expanded={open}
                              >
                                {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                              </button>
                              <button
                                type="button"
                                className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                                onClick={() => handleSelectProject(project)}
                              >
                                {project.isStarred ? (
                                  <Star
                                    size={13}
                                    className="shrink-0 fill-amber-400 text-amber-400"
                                  />
                                ) : (
                                  <Folder size={13} className="shrink-0 text-muted-foreground" />
                                )}
                                <span className="min-w-0 flex-1 truncate font-medium">
                                  {project.name}
                                </span>
                              </button>
                              <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                  <Button
                                    variant="ghost"
                                    size="icon-sm"
                                    className="h-6 w-6 shrink-0 opacity-0 group-hover:opacity-100 data-[state=open]:opacity-100"
                                  >
                                    <MoreHorizontal size={13} />
                                  </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end" className="w-44">
                                  <DropdownMenuItem onClick={() => handleSelectProject(project)}>
                                    <Plus size={14} />
                                    {getSidebarLabel("sidebar.project.newConversation")}
                                  </DropdownMenuItem>
                                  <DropdownMenuItem
                                    onClick={() => void handleToggleProjectStar(project)}
                                  >
                                    <Star size={14} />
                                    {getSidebarLabel(
                                      project.isStarred
                                        ? "sidebar.project.unstar"
                                        : "sidebar.project.star",
                                    )}
                                  </DropdownMenuItem>
                                  <DropdownMenuItem
                                    onClick={() => {
                                      setProjectRenamingId(project.id);
                                      setProjectRenameValue(project.name);
                                    }}
                                  >
                                    <Pencil size={14} />
                                    {getSidebarLabel("sidebar.project.rename")}
                                  </DropdownMenuItem>
                                  <DropdownMenuSeparator />
                                  <DropdownMenuItem
                                    className="text-destructive focus:text-destructive"
                                    onClick={() =>
                                      window.setTimeout(() => setPendingRemoveProject(project), 0)
                                    }
                                  >
                                    <Trash2 size={14} />
                                    {getSidebarLabel("sidebar.project.remove")}
                                  </DropdownMenuItem>
                                </DropdownMenuContent>
                              </DropdownMenu>
                            </div>
                          )}

                          {open && items.length === 0 && (
                            <p className="py-1.5 pl-7 pr-3 text-xs text-muted-foreground/60">
                              {getSidebarLabel("sidebar.project.noConversations")}
                            </p>
                          )}
                          {open &&
                            visible.map((conversation) => renderConversation(conversation, true))}
                          {open && remaining > 0 && (
                            <button
                              type="button"
                              className="w-full py-1.5 pl-7 pr-3 text-left text-xs text-muted-foreground/70 transition-colors hover:text-foreground"
                              onClick={() =>
                                setProjectVisibleCounts((prev) => ({
                                  ...prev,
                                  [project.id]: visibleCount + PROJECT_PAGE_STEP,
                                }))
                              }
                            >
                              {formatSidebarLabel("sidebar.project.loadMore", { count: remaining })}
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>

                  {plain.length > 0 && projects.length > 0 && (
                    <p className="px-3 pb-0 pt-3 text-[11px] font-medium text-muted-foreground/80">
                      {getSidebarLabel("sidebar.conversationsHeading")}
                    </p>
                  )}

                  {groups.map((group) => (
                    <div key={group.label}>
                      <p className="px-3 pb-1 pt-2 text-[11px] font-medium text-muted-foreground/80">
                        {getSidebarLabel(group.label)}
                      </p>
                      {group.items.map((conversation) => renderConversation(conversation))}
                    </div>
                  ))}

                  {plain.length === 0 && (
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

      <Dialog
        open={Boolean(pendingRemoveProject)}
        onOpenChange={(open) => !open && setPendingRemoveProject(null)}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{getSidebarLabel("sidebar.project.removeDialog.title")}</DialogTitle>
            <DialogDescription>
              {getSidebarLabel("sidebar.project.removeDialog.description")}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setPendingRemoveProject(null)}>
              {getSidebarLabel("sidebar.project.removeDialog.cancel")}
            </Button>
            <Button
              ref={(el) => {
                queueMicrotask(() => el?.focus());
              }}
              variant="destructive"
              onClick={() => {
                const target = pendingRemoveProject;
                setPendingRemoveProject(null);
                if (target) void handleRemoveProject(target);
              }}
            >
              {getSidebarLabel("sidebar.project.removeDialog.confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
