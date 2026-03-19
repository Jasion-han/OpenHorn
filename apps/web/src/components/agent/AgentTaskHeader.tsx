"use client";

import { Play, ShieldCheck, Square, Wand2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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

export function AgentTaskHeader({
  task,
  hasApprovedPlan,
  isPlanning,
  isExecuting,
  onPlan,
  onExecute,
  onCancel,
}: {
  task: ApiAgentTask;
  hasApprovedPlan: boolean;
  isPlanning: boolean;
  isExecuting: boolean;
  onPlan: () => void;
  onExecute: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="rounded-3xl border border-border/70 bg-background/80 p-5">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-semibold">{task.title}</h1>
            <Badge variant="secondary">{STATUS_LABELS[task.status]}</Badge>
            {hasApprovedPlan ? <Badge className="bg-emerald-500/10 text-emerald-700">计划已批准</Badge> : null}
          </div>
          <div className="mt-2 flex flex-wrap gap-4 text-xs text-muted-foreground">
            <span>创建于 {new Date(task.createdAt).toLocaleString()}</span>
            <span>更新于 {new Date(task.updatedAt).toLocaleString()}</span>
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={onPlan} disabled={isPlanning || isExecuting}>
            <Wand2 className="mr-2 h-4 w-4" />
            {isPlanning ? "生成中" : "生成计划"}
          </Button>
          <Button onClick={onExecute} disabled={!hasApprovedPlan || isExecuting || isPlanning}>
            <Play className="mr-2 h-4 w-4" />
            {isExecuting ? "执行中" : "开始执行"}
          </Button>
          <Button variant="outline" onClick={onCancel}>
            <Square className="mr-2 h-4 w-4" />
            取消任务
          </Button>
          <div className="inline-flex items-center rounded-full border border-border/60 px-3 text-xs text-muted-foreground">
            <ShieldCheck className="mr-2 h-3.5 w-3.5" />
            规划与执行分离
          </div>
        </div>
      </div>
    </div>
  );
}
