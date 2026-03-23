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
  approval,
  onApprove,
  onReject,
  embedded = false,
}: {
  planSteps: ApiAgentPlanStep[];
  approval: ApiAgentApproval | null;
  onApprove: (approvalId: string) => void;
  onReject: (approvalId: string) => void;
  embedded?: boolean;
}) {
  return (
    <section
      id="agent-plan-panel"
      className={
        embedded ? "space-y-3" : "rounded-3xl border border-border/70 bg-background/80 p-5"
      }
    >
      {!embedded ? (
        <div className="mb-4 flex items-center justify-between gap-3">
          <div>
            <div className="text-sm font-medium">执行计划</div>
            <p className="mt-1 text-xs text-muted-foreground">
              Agent 会按这组步骤自主推进，你也可以随时查看过程。
            </p>
          </div>
        </div>
      ) : null}

      {planSteps.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border/60 bg-muted/10 px-3 py-2.5 text-sm text-muted-foreground">
          当前运行没有关联的计划步骤。
        </div>
      ) : (
        <div className={embedded ? "space-y-2" : "space-y-3"}>
          {planSteps.map((step) => (
            <div
              key={step.id}
              className={
                embedded
                  ? "rounded-xl border border-border/45 bg-background/55 px-3 py-2.5"
                  : "rounded-2xl border border-border/60 bg-muted/15 p-4"
              }
            >
              <div className="flex gap-3">
                <div className="pt-0.5">
                  <StepIcon status={step.status} />
                </div>
                <div className="min-w-0">
                  <div className={embedded ? "text-[13px] font-medium" : "text-sm font-medium"}>
                    {step.orderIndex + 1}. {step.title}
                  </div>
                  {step.description ? (
                    <p
                      className={
                        embedded
                          ? "mt-1 text-[12px] leading-5 text-muted-foreground"
                          : "mt-1 text-sm text-muted-foreground"
                      }
                    >
                      {step.description}
                    </p>
                  ) : null}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {approval ? (
        <div className="mt-4">
          <AgentApprovalBlock
            approval={approval}
            onApprove={() => onApprove(approval.id)}
            onReject={() => onReject(approval.id)}
          />
        </div>
      ) : null}
    </section>
  );
}
