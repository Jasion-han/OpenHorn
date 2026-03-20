"use client";

import { useEffect, useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  RotateCcw,
  Search,
  SkipForward,
  Square,
  Wand2,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import type { ApiAgentTask } from "@/lib/api";

const TASK_LIST_SECTION_STORAGE_KEY = "openhorn.agentTaskList.sections";

const STATUS_LABELS: Record<ApiAgentTask["status"], string> = {
  draft: "草稿",
  planning: "规划中",
  awaiting_approval: "待审批",
  running: "执行中",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
};

const STATUS_TONE: Record<ApiAgentTask["status"], string> = {
  draft: "bg-muted text-muted-foreground",
  planning: "bg-amber-500/10 text-amber-700 dark:text-amber-300",
  awaiting_approval: "bg-orange-500/10 text-orange-700 dark:text-orange-300",
  running: "bg-blue-500/10 text-blue-700 dark:text-blue-300",
  completed: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  failed: "bg-destructive/10 text-destructive",
  cancelled: "bg-slate-500/10 text-slate-700 dark:text-slate-300",
};

const TASK_SECTIONS = [
  {
    id: "attention",
    label: "需要处理",
    statuses: ["awaiting_approval", "failed"],
  },
  {
    id: "recent",
    label: "最近更新",
    statuses: ["running", "planning", "draft"],
  },
  {
    id: "finished",
    label: "已结束",
    statuses: ["completed", "cancelled"],
  },
] satisfies Array<{
  id: string;
  label: string;
  statuses: ApiAgentTask["status"][];
}>;

type TaskListFilter = "all" | ApiAgentTask["status"];
type TaskSectionId = (typeof TASK_SECTIONS)[number]["id"];
export type AgentTaskQuickAction = "plan" | "retry" | "continue" | "cancel";

type TaskQuickActionSpec = {
  key: AgentTaskQuickAction;
  label: string;
  icon: typeof Wand2;
  tone?: "default" | "danger";
};

function getTaskQuickActions(status: ApiAgentTask["status"]): TaskQuickActionSpec[] {
  switch (status) {
    case "draft":
      return [{ key: "plan", label: "生成计划", icon: Wand2 }];
    case "failed":
      return [
        { key: "continue", label: "继续", icon: SkipForward },
        { key: "retry", label: "重试", icon: RotateCcw },
      ];
    case "completed":
      return [
        { key: "continue", label: "继续", icon: SkipForward },
        { key: "retry", label: "重试", icon: RotateCcw },
      ];
    case "cancelled":
      return [{ key: "retry", label: "重试", icon: RotateCcw }];
    case "running":
      return [{ key: "cancel", label: "取消", icon: Square, tone: "danger" }];
    default:
      return [];
  }
}

function getInsightLabel(task: ApiAgentTask) {
  switch (task.insight?.highlight) {
    case "tool_approval":
      return "待工具审批";
    case "plan_approval":
      return "待计划审批";
    case "execution_failed":
      return "最近执行失败";
    case "final_result":
      return "已有最终结果";
    default:
      return null;
  }
}

export function AgentTaskList({
  tasks,
  selectedTaskId,
  isMutating,
  onSelect,
  onQuickAction,
}: {
  tasks: ApiAgentTask[];
  selectedTaskId: string | null;
  isMutating: boolean;
  onSelect: (taskId: string) => void;
  onQuickAction: (taskId: string, action: AgentTaskQuickAction) => Promise<void> | void;
}) {
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<TaskListFilter>("all");
  const [expandedSections, setExpandedSections] = useState<Set<TaskSectionId>>(
    () => new Set(TASK_SECTIONS.map((section) => section.id)),
  );
  const normalizedQuery = query.trim().toLowerCase();

  const statusCounts = useMemo(() => {
    return tasks.reduce<Record<ApiAgentTask["status"], number>>(
      (acc, task) => {
        acc[task.status] += 1;
        return acc;
      },
      {
        draft: 0,
        planning: 0,
        awaiting_approval: 0,
        running: 0,
        completed: 0,
        failed: 0,
        cancelled: 0,
      },
    );
  }, [tasks]);

  const filteredTasks = useMemo(() => {
    return tasks.filter((task) => {
      if (statusFilter !== "all" && task.status !== statusFilter) {
        return false;
      }

      if (!normalizedQuery) {
        return true;
      }

      const insightLabel = getInsightLabel(task);
      return [task.title, task.goal, insightLabel, task.insight?.summary]
        .filter((value): value is string => Boolean(value))
        .some((value) => value.toLowerCase().includes(normalizedQuery));
    });
  }, [normalizedQuery, statusFilter, tasks]);

  const taskSections = useMemo(() => {
    return TASK_SECTIONS.map((section) => ({
      ...section,
      tasks: filteredTasks.filter((task) =>
        section.statuses.some((status) => status === task.status),
      ),
    })).filter((section) => section.tasks.length > 0);
  }, [filteredTasks]);

  const filterOptions = [
    { value: "all", label: "全部", count: tasks.length },
    { value: "awaiting_approval", label: "待审批", count: statusCounts.awaiting_approval },
    { value: "running", label: "执行中", count: statusCounts.running },
    { value: "failed", label: "失败", count: statusCounts.failed },
    { value: "completed", label: "已完成", count: statusCounts.completed },
  ] satisfies Array<{ value: TaskListFilter; label: string; count: number }>;

  const visibleFilterOptions = filterOptions.filter(
    (option) => option.value === "all" || option.count > 0,
  );
  const showSectionHeaders = statusFilter === "all" && !normalizedQuery && taskSections.length > 1;

  useEffect(() => {
    if (typeof window === "undefined") return;

    const raw = window.localStorage.getItem(TASK_LIST_SECTION_STORAGE_KEY);
    if (!raw) return;

    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return;

      const allowedIds = new Set(TASK_SECTIONS.map((section) => section.id));
      const next = parsed.filter(
        (value): value is TaskSectionId =>
          typeof value === "string" && allowedIds.has(value as TaskSectionId),
      );

      if (next.length > 0) {
        setExpandedSections(new Set(next));
      }
    } catch {
      // Ignore malformed local state and keep defaults.
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(
      TASK_LIST_SECTION_STORAGE_KEY,
      JSON.stringify(Array.from(expandedSections)),
    );
  }, [expandedSections]);

  useEffect(() => {
    if (!selectedTaskId || !showSectionHeaders) return;

    const ownerSection = taskSections.find((section) =>
      section.tasks.some((task) => task.id === selectedTaskId),
    );

    if (!ownerSection || expandedSections.has(ownerSection.id)) return;

    setExpandedSections((prev) => {
      const next = new Set(prev);
      next.add(ownerSection.id);
      return next;
    });
  }, [expandedSections, selectedTaskId, showSectionHeaders, taskSections]);

  const toggleSection = (sectionId: TaskSectionId) => {
    setExpandedSections((prev) => {
      const next = new Set(prev);
      if (next.has(sectionId)) next.delete(sectionId);
      else next.add(sectionId);
      return next;
    });
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="space-y-3 pr-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索任务..."
            className="pl-9"
          />
        </div>

        <div className="flex flex-wrap gap-2">
          {visibleFilterOptions.map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => setStatusFilter(option.value)}
              className={cn(
                "inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] transition-colors",
                statusFilter === option.value
                  ? "border-foreground/20 bg-foreground/[0.06] text-foreground"
                  : "border-border/60 bg-background/70 text-muted-foreground hover:bg-muted/30",
              )}
            >
              {option.label} {option.count}
            </button>
          ))}
        </div>
      </div>

      <ScrollArea className="h-full">
        <div className="space-y-2 pr-3">
        {tasks.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-border/70 bg-muted/20 p-4 text-sm text-muted-foreground">
            还没有任务。先在上方创建一个目标，再生成计划。
          </div>
        ) : null}

        {tasks.length > 0 && filteredTasks.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-border/70 bg-muted/20 p-4 text-sm text-muted-foreground">
            没有匹配的任务。试试更换关键词或筛选条件。
          </div>
        ) : null}

        {taskSections.map((section) => (
          <div key={section.id} className="space-y-2">
            {showSectionHeaders ? (
              <button
                type="button"
                onClick={() => toggleSection(section.id)}
                className="flex w-full items-center justify-between rounded-xl px-1 py-1 text-left text-[11px] font-medium tracking-[0.12em] text-muted-foreground/80 transition-colors hover:bg-muted/20"
              >
                <span className="inline-flex items-center gap-1.5">
                  {expandedSections.has(section.id) ? (
                    <ChevronDown className="h-3.5 w-3.5" />
                  ) : (
                    <ChevronRight className="h-3.5 w-3.5" />
                  )}
                  <span>{section.label}</span>
                </span>
                <span className="rounded-full border border-border/60 bg-background/80 px-2 py-0.5 text-[10px] tracking-normal text-muted-foreground">
                  {section.tasks.length}
                </span>
              </button>
            ) : null}

            {(showSectionHeaders && !expandedSections.has(section.id) ? [] : section.tasks).map((task) => {
              const quickActions = getTaskQuickActions(task.status);
              const insightLabel = getInsightLabel(task);
              return (
                <div
                  key={task.id}
                  onClick={() => onSelect(task.id)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      onSelect(task.id);
                    }
                  }}
                  role="button"
                  tabIndex={0}
                  className={cn(
                    "w-full rounded-2xl border p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground/20",
                    task.id === selectedTaskId
                      ? "border-foreground/20 bg-foreground/[0.05]"
                      : "border-border/60 bg-background/70 hover:bg-muted/30",
                  )}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium">{task.title}</div>
                      <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{task.goal}</p>
                    </div>
                    <Badge className={cn("shrink-0 border-0", STATUS_TONE[task.status])}>
                      {STATUS_LABELS[task.status]}
                    </Badge>
                  </div>

                  {insightLabel ? (
                    <div className="mt-3">
                      <span className="inline-flex rounded-full border border-border/60 bg-muted/20 px-2 py-1 text-[11px] text-foreground/80">
                        {insightLabel}
                      </span>
                    </div>
                  ) : null}

                  {task.insight?.summary ? (
                    <p className="mt-2 line-clamp-2 text-[11px] leading-5 text-muted-foreground">
                      {task.insight.summary}
                    </p>
                  ) : null}

                  <div className="mt-3 text-[11px] text-muted-foreground">
                    更新于 {new Date(task.updatedAt).toLocaleString()}
                  </div>

                  {quickActions.length > 0 ? (
                    <div className="mt-3 flex flex-wrap gap-2">
                      {quickActions.map((action) => {
                        const Icon = action.icon;
                        return (
                          <button
                            key={action.key}
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              void onQuickAction(task.id, action.key);
                            }}
                            className={cn(
                              "inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] transition-colors",
                              action.tone === "danger"
                                ? "border-destructive/20 bg-destructive/5 text-destructive hover:bg-destructive/10"
                                : "border-border/60 bg-background/80 text-foreground/80 hover:bg-muted/40",
                            )}
                            disabled={isMutating}
                          >
                            <Icon className="mr-1.5 h-3.5 w-3.5" />
                            {action.label}
                          </button>
                        );
                      })}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        ))}
        </div>
      </ScrollArea>
    </div>
  );
}
