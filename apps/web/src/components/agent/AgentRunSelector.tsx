"use client";

import { History } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ApiAgentTaskRun } from "@/lib/api";

const RUN_PHASE_LABELS: Record<ApiAgentTaskRun["phase"], string> = {
  planning: "规划",
  execution: "执行",
};

const RUN_STATUS_LABELS: Record<ApiAgentTaskRun["status"], string> = {
  pending: "待处理",
  running: "进行中",
  awaiting_approval: "待审批",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
};

export function AgentRunSelector({
  runs,
  selectedRunId,
  onSelect,
}: {
  runs: ApiAgentTaskRun[];
  selectedRunId: string | null;
  onSelect: (runId: string) => void;
}) {
  if (runs.length === 0) return null;

  return (
    <section className="rounded-3xl border border-border/70 bg-background/80 p-5">
      <div className="mb-4 flex items-center gap-2">
        <History className="h-4 w-4" />
        <div>
          <div className="text-sm font-medium">运行历史</div>
          <p className="mt-1 text-xs text-muted-foreground">切换查看不同规划/执行轮次的上下文与结果。</p>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        {runs.map((run, index) => (
          <Button
            key={run.id}
            size="sm"
            variant={run.id === selectedRunId ? "default" : "outline"}
            onClick={() => onSelect(run.id)}
            className="h-auto min-w-[140px] justify-start px-3 py-2 text-left"
          >
            <div>
              <div className="text-xs opacity-80">
                #{runs.length - index} {RUN_PHASE_LABELS[run.phase]}
              </div>
              <div className="mt-1 text-sm">{RUN_STATUS_LABELS[run.status]}</div>
              <div className="mt-1 text-[11px] opacity-70">
                {new Date(run.createdAt).toLocaleString()}
              </div>
            </div>
          </Button>
        ))}
      </div>
    </section>
  );
}
