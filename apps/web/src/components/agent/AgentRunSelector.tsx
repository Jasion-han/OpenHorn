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

export type AgentRunSummary = {
  runId: string;
  summary: string | null;
  toolStarts: number;
  hasFinalResult: boolean;
};

export function AgentRunSelector({
  runs,
  summaries,
  selectedRunId,
  onSelect,
}: {
  runs: ApiAgentTaskRun[];
  summaries: AgentRunSummary[];
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
        {runs.map((run, index) => {
          const summary = summaries.find((item) => item.runId === run.id) ?? null;
          return (
            <Button
              key={run.id}
              size="sm"
              variant={run.id === selectedRunId ? "default" : "outline"}
              onClick={() => onSelect(run.id)}
              className="h-auto min-w-[220px] justify-start px-3 py-3 text-left"
            >
              <div className="w-full">
                <div className="flex items-center justify-between gap-3">
                  <div className="text-xs opacity-80">
                    #{runs.length - index} {RUN_PHASE_LABELS[run.phase]}
                  </div>
                  <div className="text-[11px] opacity-70">{RUN_STATUS_LABELS[run.status]}</div>
                </div>

                <div className="mt-2 text-[11px] opacity-70">
                  {new Date(run.createdAt).toLocaleString()}
                </div>

                <div className="mt-2 flex flex-wrap gap-2 text-[11px] opacity-80">
                  {run.phase === "execution" ? (
                    <span>工具 {summary?.toolStarts ?? 0}</span>
                  ) : null}
                  {summary?.hasFinalResult ? <span>有结果</span> : null}
                </div>

                {summary?.summary ? (
                  <p className="mt-2 line-clamp-3 whitespace-pre-wrap break-words text-xs leading-5 opacity-85">
                    {summary.summary}
                  </p>
                ) : null}
              </div>
            </Button>
          );
        })}
      </div>
    </section>
  );
}
