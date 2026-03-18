"use client";

import { Bot, Check, MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { api } from "@/lib/api";
import { notifyError, notifySuccess } from "@/lib/notify";
import { cn } from "@/lib/utils";
import { useAgentStore } from "@/stores/agentStore";
import { useAuthStore } from "@/stores/authStore";
import { BACKEND_UP_EVENT } from "@/stores/backendStatusStore";

type DateGroup = "今天" | "昨天" | "更早";

type AgentSessionItem = {
  id: string;
  title: string;
  channelId?: string;
  status: "active" | "completed" | "cancelled";
  createdAt: Date;
  updatedAt: Date;
};

type AgentEventItem = {
  id?: string;
  type: "user" | "meta" | "text" | "tool_start" | "tool_result" | "done" | "error";
  content?: string;
  toolName?: string;
  toolInput?: unknown;
};

function parseAgentSession(raw: unknown): AgentSessionItem | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const id = typeof obj.id === "string" ? obj.id : null;
  if (!id) return null;
  const title = typeof obj.title === "string" ? obj.title : "";
  const statusRaw = typeof obj.status === "string" ? obj.status : "active";
  const status: AgentSessionItem["status"] =
    statusRaw === "completed" || statusRaw === "cancelled" || statusRaw === "active"
      ? statusRaw
      : "active";
  const createdAt = new Date(typeof obj.createdAt === "string" ? obj.createdAt : Date.now());
  const updatedAt = new Date(typeof obj.updatedAt === "string" ? obj.updatedAt : createdAt);
  return {
    id,
    title,
    channelId: typeof obj.channelId === "string" ? obj.channelId : undefined,
    status,
    createdAt,
    updatedAt,
  };
}

function parseAgentEvents(raw: unknown): AgentEventItem[] {
  if (!Array.isArray(raw)) return [];
  const out: AgentEventItem[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    const typeRaw = typeof obj.type === "string" ? obj.type : "";
    if (!typeRaw) continue;
    const type =
      typeRaw === "user" ||
      typeRaw === "meta" ||
      typeRaw === "text" ||
      typeRaw === "tool_start" ||
      typeRaw === "tool_result" ||
      typeRaw === "done" ||
      typeRaw === "error"
        ? typeRaw
        : null;
    if (!type) continue;
    out.push({
      id: typeof obj.id === "string" ? obj.id : undefined,
      type,
      content: typeof obj.content === "string" ? obj.content : undefined,
      toolName: typeof obj.toolName === "string" ? obj.toolName : undefined,
      toolInput: obj.toolInput,
    });
  }
  return out;
}

function groupByUpdatedAt<T extends { updatedAt?: Date; createdAt?: Date }>(
  items: T[],
): Array<{ label: DateGroup; items: T[] }> {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const yesterdayStart = todayStart - 86_400_000;

  const today: T[] = [];
  const yesterday: T[] = [];
  const earlier: T[] = [];

  for (const item of items) {
    const ts = (item.updatedAt || item.createdAt || new Date(0)).getTime();
    if (ts >= todayStart) today.push(item);
    else if (ts >= yesterdayStart) yesterday.push(item);
    else earlier.push(item);
  }

  const groups: Array<{ label: DateGroup; items: T[] }> = [];
  if (today.length) groups.push({ label: "今天", items: today });
  if (yesterday.length) groups.push({ label: "昨天", items: yesterday });
  if (earlier.length) groups.push({ label: "更早", items: earlier });
  return groups;
}

function formatNewAgentSessionTitle() {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  return `任务 ${mm}-${dd} ${hh}:${min}`;
}

export function AgentSessionsAside() {
  const { user } = useAuthStore();
  const {
    sessions,
    currentSession,
    addSession,
    setSessions,
    setCurrentSession,
    patchCurrentSession,
    setEvents,
  } = useAgentStore();

  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [bootstrapping, setBootstrapping] = useState(false);

  const [renameOpen, setRenameOpen] = useState(false);
  const [renameSession, setRenameSession] = useState<AgentSessionItem | null>(null);
  const [renameValue, setRenameValue] = useState("");

  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteSession, setDeleteSession] = useState<AgentSessionItem | null>(null);

  const bootstrap = useCallback(async () => {
    setBootstrapping(true);
    try {
      const { sessions: sessionsResp } = await api.agent.listSessions();
      const parsed = sessionsResp
        .map(parseAgentSession)
        .filter((s): s is AgentSessionItem => Boolean(s));
      setSessions(parsed);
    } catch (error) {
      notifyError("加载失败", error instanceof Error ? error.message : "无法加载 Agent 数据");
    } finally {
      setBootstrapping(false);
    }
  }, [setSessions]);

  useEffect(() => {
    if (user) void bootstrap();
  }, [bootstrap, user]);

  useEffect(() => {
    if (!user) return;
    const onUp = () => void bootstrap();
    window.addEventListener(BACKEND_UP_EVENT, onUp);
    return () => window.removeEventListener(BACKEND_UP_EVENT, onUp);
  }, [bootstrap, user]);

  const filteredSessions = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sessions;
    return sessions.filter((s) => (s.title || "").toLowerCase().includes(q));
  }, [query, sessions]);

  const loadSessionEvents = async (sessionId: string) => {
    try {
      const { events } = await api.agent.listEvents(sessionId);
      setEvents(parseAgentEvents(events));
    } catch {
      // Best-effort
      setEvents([]);
    }
  };

  const handleSelectSession = (session: AgentSessionItem) => {
    setCurrentSession(session);
    void loadSessionEvents(session.id);
  };

  const handleNewSession = async () => {
    setCreating(true);
    try {
      const { session } = await api.agent.createSession({
        title: formatNewAgentSessionTitle(),
      });
      const parsed = parseAgentSession(session);
      if (!parsed) throw new Error("Invalid session");
      addSession(parsed);
      handleSelectSession(parsed);
      notifySuccess("已创建", "新会话已创建");
    } catch (error) {
      notifyError("创建失败", error instanceof Error ? error.message : "无法创建会话");
    } finally {
      setCreating(false);
    }
  };

  const openRenameDialog = (session: AgentSessionItem) => {
    setRenameSession(session);
    setRenameValue(session?.title || "");
    setRenameOpen(true);
  };

  const submitRename = async () => {
    if (!renameSession) return;
    const nextTitle = renameValue.trim();
    if (!nextTitle) return;

    try {
      await api.agent.renameSession(renameSession.id, nextTitle);
      setSessions(
        sessions.map((s) => (s.id === renameSession.id ? { ...s, title: nextTitle } : s)),
      );
      if (currentSession?.id === renameSession.id) {
        patchCurrentSession({ title: nextTitle });
      }
      notifySuccess("已保存", "会话已重命名");
      setRenameOpen(false);
      setRenameSession(null);
    } catch (error) {
      notifyError("保存失败", error instanceof Error ? error.message : "无法重命名会话");
      void bootstrap();
    }
  };

  const handleToggleCompleted = async (session: AgentSessionItem) => {
    const next = session.status === "completed" ? "active" : "completed";
    try {
      await api.agent.updateStatus(session.id, next);
      setSessions(sessions.map((s) => (s.id === session.id ? { ...s, status: next } : s)));
      if (currentSession?.id === session.id) {
        patchCurrentSession({ status: next });
      }
      notifySuccess("已更新", next === "completed" ? "已标记完成" : "已恢复为进行中");
    } catch (error) {
      notifyError("更新失败", error instanceof Error ? error.message : "无法更新状态");
      void bootstrap();
    }
  };

  const openDeleteDialog = (session: AgentSessionItem) => {
    setDeleteSession(session);
    setDeleteOpen(true);
  };

  const submitDelete = async () => {
    if (!deleteSession) return;
    try {
      await api.agent.deleteSession(deleteSession.id);
      setSessions(sessions.filter((s) => s.id !== deleteSession.id));
      if (currentSession?.id === deleteSession.id) {
        setCurrentSession(null);
        setEvents([]);
      }
      notifySuccess("已删除", "会话已删除");
      setDeleteOpen(false);
      setDeleteSession(null);
    } catch (error) {
      notifyError("删除失败", error instanceof Error ? error.message : "无法删除会话");
      void bootstrap();
    }
  };

  const groups = useMemo(() => groupByUpdatedAt(filteredSessions), [filteredSessions]);

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 p-2">
      <Button className="w-full" onClick={() => void handleNewSession()} disabled={creating}>
        <Plus size={16} /> 新会话
      </Button>

      <Input placeholder="搜索会话..." value={query} onChange={(e) => setQuery(e.target.value)} />

      <ScrollArea className="flex-1">
        <div className="flex flex-col gap-1 pr-3">
          {groups.map((group) => (
            <div key={group.label}>
              <p className="px-2 py-1 text-xs font-semibold text-muted-foreground">{group.label}</p>
              {group.items.map((session) => {
                const active = currentSession?.id === session.id;
                const statusVariant =
                  session.status === "completed"
                    ? "secondary"
                    : session.status === "cancelled"
                      ? "destructive"
                      : "outline";

                return (
                  // biome-ignore lint/a11y/useSemanticElements: cannot use <button> due to nested interactive menu controls
                  <div
                    key={session.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => handleSelectSession(session)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        handleSelectSession(session);
                      }
                    }}
                    className={cn(
                      "group w-full flex flex-col gap-1.5 px-3 py-[7px] rounded-[10px] transition-colors duration-100 titlebar-no-drag text-left border border-transparent",
                      active
                        ? "bg-foreground/[0.08] text-foreground shadow-[0_1px_2px_0_rgba(0,0,0,0.05)]"
                        : "hover:bg-foreground/[0.04] text-foreground/70",
                    )}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex min-w-0 items-center gap-2">
                        <Bot size={16} className="shrink-0" />
                        <span className="truncate text-[13px] leading-5">{session.title}</span>
                      </div>

                      <DropdownMenu>
                        <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            className="opacity-0 group-hover:opacity-100 h-7 w-7 shrink-0"
                            aria-label="会话操作"
                          >
                            <MoreHorizontal size={14} />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-40">
                          <DropdownMenuItem
                            onClick={(e) => {
                              e.stopPropagation();
                              openRenameDialog(session);
                            }}
                          >
                            <Pencil size={14} /> 重命名
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onClick={(e) => {
                              e.stopPropagation();
                              void handleToggleCompleted(session);
                            }}
                          >
                            <Check size={14} />{" "}
                            {session.status === "completed" ? "恢复进行中" : "标记完成"}
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            className="text-destructive"
                            onClick={(e) => {
                              e.stopPropagation();
                              openDeleteDialog(session);
                            }}
                          >
                            <Trash2 size={14} /> 删除
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>

                    <div className="flex items-center gap-2">
                      <Badge variant={statusVariant} className="h-5 px-1.5 text-[11px]">
                        {session.status === "active" ? "active" : session.status}
                      </Badge>
                    </div>
                  </div>
                );
              })}
            </div>
          ))}

          {filteredSessions.length === 0 && (
            <p className="py-10 text-center text-xs text-muted-foreground">
              {bootstrapping ? "加载中..." : "暂无会话"}
            </p>
          )}
        </div>
      </ScrollArea>

      <Dialog open={renameOpen} onOpenChange={(o) => !o && setRenameOpen(false)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>重命名会话</DialogTitle>
            <DialogDescription>为该会话设置一个更易识别的标题。</DialogDescription>
          </DialogHeader>
          <Input value={renameValue} onChange={(e) => setRenameValue(e.target.value)} />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRenameOpen(false)}>
              取消
            </Button>
            <Button onClick={() => void submitRename()} disabled={!renameValue.trim()}>
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={deleteOpen} onOpenChange={(o) => !o && setDeleteOpen(false)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>删除会话</DialogTitle>
            <DialogDescription>确定删除该会话？此操作不可恢复。</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeleteOpen(false)}>
              取消
            </Button>
            <Button variant="destructive" onClick={() => void submitDelete()}>
              删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
