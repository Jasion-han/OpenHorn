"use client";

import { Badge } from "@/components/ui/badge";
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

export type AgentTaskListInsight = {
  taskId: string;
  highlight: string | null;
  summary: string | null;
};

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
  return (
    <ScrollArea className="h-full">
      <div className="space-y-2 pr-3">
        {tasks.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-border/70 bg-muted/20 p-4 text-sm text-muted-foreground">
            还没有任务。先在上方创建一个目标，再生成计划。
          </div>
        ) : null}

        {tasks.map((task) => {
          const insight = insights.find((item) => item.taskId === task.id) ?? null;
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
                <p className="mt-2 line-clamp-2 text-[11px] leading-5 text-muted-foreground">{insight.summary}</p>
              ) : null}

              <div className="mt-3 text-[11px] text-muted-foreground">
                更新于 {new Date(task.updatedAt).toLocaleString()}
              </div>
            </button>
          );
        })}
      </div>
    </ScrollArea>
  );
}
