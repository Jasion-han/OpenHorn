"use client";

import { CheckCircle2, CircleDashed, Clock3, XCircle } from "lucide-react";
import type { ApiAgentApproval, ApiAgentPlanStep } from "@/lib/api";
import { AgentApprovalBlock } from "./AgentApprovalBlock";

function StepIcon({ status }: { status: ApiAgentPlanStep["status"] }) {
  if (status === "completed") return <CheckCircle2 className="h-4 w-4 text-emerald-600" />;
  if (status === "failed") return <XCircle className="h-4 w-4 text-destructive" />;
  if (status === "running") return <Clock3 className="h-4 w-4 text-blue-600" />;
  return <CircleDashed className="h-4 w-4 text-muted-foreground" />;
}

export function AgentPlanPanel({
  planSteps,
  approvals,
  onApprove,
  onReject,
}: {
  planSteps: ApiAgentPlanStep[];
  approvals: ApiAgentApproval[];
  onApprove: (approvalId: string) => void;
  onReject: (approvalId: string) => void;
}) {
  const latestApproval = approvals[0] ?? null;

  return (
    <section className="rounded-3xl border border-border/70 bg-background/80 p-5">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div>
          <div className="text-sm font-medium">执行计划</div>
          <p className="mt-1 text-xs text-muted-foreground">先审阅计划，再决定是否执行。</p>
        </div>
      </div>

      {planSteps.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border/70 bg-muted/20 p-4 text-sm text-muted-foreground">
          还没有计划。点击上方“生成计划”。
        </div>
      ) : (
        <div className="space-y-3">
          {planSteps.map((step) => (
            <div key={step.id} className="rounded-2xl border border-border/60 bg-muted/15 p-4">
              <div className="flex gap-3">
                <StepIcon status={step.status} />
                <div className="min-w-0">
                  <div className="text-sm font-medium">
                    {step.orderIndex + 1}. {step.title}
                  </div>
                  {step.description ? (
                    <p className="mt-1 text-sm text-muted-foreground">{step.description}</p>
                  ) : null}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {latestApproval ? (
        <div className="mt-4">
          <AgentApprovalBlock
            approval={latestApproval}
            onApprove={() => onApprove(latestApproval.id)}
            onReject={() => onReject(latestApproval.id)}
          />
        </div>
      ) : null}
    </section>
  );
}
