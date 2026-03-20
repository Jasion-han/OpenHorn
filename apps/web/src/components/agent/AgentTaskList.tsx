"use client";

import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import type { ApiAgentTask } from "@/lib/api";

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

export type AgentTaskListInsight = {
  taskId: string;
  highlight: string | null;
  summary: string | null;
};

type TaskListFilter = "all" | ApiAgentTask["status"];

export function AgentTaskList({
  tasks,
  insights,
  selectedTaskId,
  onSelect,
}: {
  tasks: ApiAgentTask[];
  insights: AgentTaskListInsight[];
  selectedTaskId: string | null;
  onSelect: (taskId: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<TaskListFilter>("all");
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

  const insightByTaskId = useMemo(
    () => new Map(insights.map((item) => [item.taskId, item])),
    [insights],
  );

  const filteredTasks = useMemo(() => {
    return tasks.filter((task) => {
      if (statusFilter !== "all" && task.status !== statusFilter) {
        return false;
      }

      if (!normalizedQuery) {
        return true;
      }

      const insight = insightByTaskId.get(task.id) ?? null;
      return [task.title, task.goal, insight?.highlight, insight?.summary]
        .filter((value): value is string => Boolean(value))
        .some((value) => value.toLowerCase().includes(normalizedQuery));
    });
  }, [insightByTaskId, normalizedQuery, statusFilter, tasks]);

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
              <div className="px-1 text-[11px] font-medium tracking-[0.12em] text-muted-foreground/80">
                {section.label}
              </div>
            ) : null}

            {section.tasks.map((task) => {
              const insight = insightByTaskId.get(task.id) ?? null;
              return (
                <button
                  key={task.id}
                  type="button"
                  onClick={() => onSelect(task.id)}
                  className={cn(
                    "w-full rounded-2xl border p-3 text-left transition-colors",
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

                  {insight?.highlight ? (
                    <div className="mt-3">
                      <span className="inline-flex rounded-full border border-border/60 bg-muted/20 px-2 py-1 text-[11px] text-foreground/80">
                        {insight.highlight}
                      </span>
                    </div>
                  ) : null}

                  {insight?.summary ? (
                    <p className="mt-2 line-clamp-2 text-[11px] leading-5 text-muted-foreground">
                      {insight.summary}
                    </p>
                  ) : null}

                  <div className="mt-3 text-[11px] text-muted-foreground">
                    更新于 {new Date(task.updatedAt).toLocaleString()}
                  </div>
                </button>
              );
            })}
          </div>
        ))}
        </div>
      </ScrollArea>
    </div>
  );
}
