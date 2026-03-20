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
  defaultRunId,
  onSelect,
}: {
  runs: ApiAgentTaskRun[];
  summaries: AgentRunSummary[];
  selectedRunId: string | null;
  defaultRunId: string | null;
  onSelect: (runId: string) => void;
}) {
  if (runs.length === 0) return null;

  const defaultRun = runs.find((run) => run.id === defaultRunId) ?? runs[0] ?? null;
  const defaultLabel = defaultRun ? `最近${RUN_PHASE_LABELS[defaultRun.phase]}` : "最近一轮";
  const headerHint =
    selectedRunId && defaultRun && selectedRunId === defaultRun.id
      ? `当前默认查看${defaultLabel}。可切换查看不同规划/执行轮次的上下文与结果。`
      : `默认打开${defaultLabel}。可切换查看不同规划/执行轮次的上下文与结果。`;

  return (
    <section className="rounded-3xl border border-border/70 bg-background/80 p-5">
      <div className="mb-4 flex items-center gap-2">
        <History className="h-4 w-4" />
        <div>
          <div className="text-sm font-medium">运行历史</div>
          <p className="mt-1 text-xs text-muted-foreground">{headerHint}</p>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        {runs.map((run, index) => {
          const summary = summaries.find((item) => item.runId === run.id) ?? null;
          const isSelected = run.id === selectedRunId;
          const isDefault = run.id === defaultRun?.id;
          const selectionBadge = isSelected && isDefault
            ? "当前默认"
            : isSelected
              ? "当前查看"
              : isDefault
                ? "默认打开"
                : null;

          return (
            <Button
              key={run.id}
              size="sm"
              variant={isSelected ? "default" : "outline"}
              onClick={() => onSelect(run.id)}
              className="h-auto min-w-[220px] justify-start px-3 py-3 text-left"
            >
              <div className="w-full">
                <div className="flex items-center justify-between gap-3">
                  <div className="text-xs opacity-80">
                    #{runs.length - index} {RUN_PHASE_LABELS[run.phase]}
                  </div>
                  <div className="flex items-center gap-2">
                    {selectionBadge ? (
                      <span className="rounded-full border border-current/15 px-2 py-0.5 text-[10px] font-medium opacity-80">
                        {selectionBadge}
                      </span>
                    ) : null}
                    <div className="text-[11px] opacity-70">{RUN_STATUS_LABELS[run.status]}</div>
                  </div>
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
