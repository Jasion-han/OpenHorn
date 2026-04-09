import { cn } from "ui";
import {
  agentPanelLabels,
  getAgentActionLabel,
  getAgentPlanStepStatusLabel,
} from "../../lib/i18n/agent";
import type { ApiAgentApproval, ApiAgentPlanStep } from "../../types/chat";

/**
 * Renders the agent's generated plan, plus an inline plan-approval form
 * when there is a pending plan_approval.
 *
 * Display rules:
 *   - Plan steps are real backend records. We display step.title and
 *     step.description verbatim — they come from agentPlanBuilder on the
 *     server in English, and we don't translate model-emitted text on the
 *     frontend.
 *   - Step status badges are looked up via the i18n dictionary so the
 *     status label is in Chinese while the step body stays in English.
 *   - The "通过 / 拒绝" buttons are only rendered when there is a pending
 *     plan_approval. Approval submission is delegated to the parent
 *     through onApprove / onReject so this component stays IO-free and
 *     trivially testable.
 */
export function DesktopAgentPlanPanel({
  planSteps,
  pendingApproval,
  submitting,
  submitError,
  onApprove,
  onReject,
}: {
  planSteps: ApiAgentPlanStep[];
  pendingApproval: ApiAgentApproval | null;
  submitting: boolean;
  submitError: string | null;
  onApprove: (approvalId: string) => void;
  onReject: (approvalId: string) => void;
}) {
  if (planSteps.length === 0) return null;

  const sortedSteps = [...planSteps].sort((left, right) => left.orderIndex - right.orderIndex);
  const isPlanApproval =
    pendingApproval !== null && pendingApproval.type === "plan_approval";

  return (
    <section
      data-testid="agent-plan-panel"
      className={cn(
        "mt-1 rounded-lg border bg-background/50 px-3 py-2.5",
        isPlanApproval ? "border-amber-300/60" : "border-border/40",
      )}
    >
      <header className="flex items-center justify-between gap-2 pb-1.5">
        <span className="text-xs font-medium uppercase tracking-wide text-foreground/55">
          {isPlanApproval
            ? agentPanelLabels.planApprovalHeading
            : agentPanelLabels.planSectionHeading}
        </span>
      </header>

      <ol className="flex flex-col gap-1.5 text-sm leading-6">
        {sortedSteps.map((step, index) => {
          const statusLabel = getAgentPlanStepStatusLabel(step.status);
          const isActive = step.status === "running";
          const isDone = step.status === "completed";
          const isFailed = step.status === "failed";
          return (
            <li key={step.id} className="flex items-start gap-2">
              <span
                aria-hidden="true"
                className={cn(
                  "mt-1.5 inline-flex h-1.5 w-1.5 shrink-0 rounded-full",
                  isFailed
                    ? "bg-destructive/70"
                    : isDone
                      ? "bg-emerald-500/70"
                      : isActive
                        ? "bg-blue-500/70 animate-pulse"
                        : "bg-foreground/25",
                )}
              />
              <span className="min-w-0 flex-1">
                <span className="text-foreground/65 mr-1.5 tabular-nums">{index + 1}.</span>
                <span
                  className={cn(
                    isDone ? "text-foreground/55 line-through decoration-foreground/30" : "text-foreground/85",
                  )}
                >
                  {step.title}
                </span>
                {statusLabel ? (
                  <span
                    className={cn(
                      "ml-2 inline-block rounded px-1.5 py-px text-[10px]",
                      isFailed
                        ? "bg-destructive/12 text-destructive/80"
                        : isDone
                          ? "bg-emerald-500/12 text-emerald-700"
                          : isActive
                            ? "bg-blue-500/12 text-blue-700"
                            : "bg-foreground/8 text-foreground/55",
                    )}
                  >
                    {statusLabel}
                  </span>
                ) : null}
                {step.description ? (
                  <span className="block text-xs leading-5 text-foreground/50">
                    {step.description}
                  </span>
                ) : null}
              </span>
            </li>
          );
        })}
      </ol>

      {isPlanApproval && pendingApproval ? (
        <div className="mt-3 border-t border-amber-200/40 pt-2.5">
          <p className="mb-2 text-xs text-foreground/60">{agentPanelLabels.planApprovalHint}</p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              data-testid="agent-plan-approve"
              onClick={() => onApprove(pendingApproval.id)}
              disabled={submitting}
              className={cn(
                "rounded-md px-3 py-1 text-xs font-medium transition-colors",
                "bg-emerald-600 text-white hover:bg-emerald-700",
                "disabled:opacity-60 disabled:cursor-not-allowed",
              )}
            >
              {submitting ? agentPanelLabels.approvalSubmitting : getAgentActionLabel("approve")}
            </button>
            <button
              type="button"
              data-testid="agent-plan-reject"
              onClick={() => onReject(pendingApproval.id)}
              disabled={submitting}
              className={cn(
                "rounded-md border px-3 py-1 text-xs font-medium transition-colors",
                "border-border/60 text-foreground/70 hover:bg-foreground/5",
                "disabled:opacity-60 disabled:cursor-not-allowed",
              )}
            >
              {getAgentActionLabel("reject")}
            </button>
            {submitError ? (
              <span className="text-xs text-destructive/80">
                {agentPanelLabels.approvalSubmitFailed}: {submitError}
              </span>
            ) : null}
          </div>
        </div>
      ) : null}
    </section>
  );
}
