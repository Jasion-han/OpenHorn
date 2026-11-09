import type { ReviewRun } from "shared/types";
import { Button } from "ui";
import {
  formatWorkbenchLabel as format,
  getJevLabel,
  getWorkbenchLabel as label,
} from "../../../lib/i18n/agent";

export function ReviewRuns({
  runs,
  busy,
  onOpen,
  onSync,
}: {
  runs: ReviewRun[];
  busy: boolean;
  onOpen(run: ReviewRun): void;
  onSync(run: ReviewRun): void;
}) {
  return (
    <section className="space-y-3 border-t pt-5">
      <h2 className="text-base font-semibold">{label("reviews.history")}</h2>
      {!runs.length && <p className="text-sm text-muted-foreground">{label("reviews.noRuns")}</p>}
      <ol className="divide-y">
        {[...runs].reverse().map((run) => (
          <li key={run.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
            <div className="min-w-0 space-y-1">
              <p className="text-sm font-medium">
                {run.engine === "jev"
                  ? getJevLabel(
                      run.decision?.status === "completed"
                        ? "jev.reviews.completed"
                        : run.decision?.status === "failed"
                          ? "jev.reviews.failed"
                          : "jev.reviews.pending",
                    )
                  : label(run.results ? "reviews.imported" : "reviews.pending")}{" "}
                <span className="ml-2 font-normal text-muted-foreground">
                  {format("reviews.runSummary", {
                    count: run.inputs.length,
                    time: new Date(run.createdAt).toLocaleString(),
                  })}
                </span>
              </p>
              <p className="break-all font-mono text-xs text-muted-foreground">
                {run.inputs.map((row) => row.id).join(", ")}
              </p>
              {run.decision?.usage && (
                <p className="text-xs text-muted-foreground">
                  {getJevLabel("jev.reviews.cost").replace(
                    "{cost}",
                    run.decision.usage.costUsd.toFixed(6),
                  )}
                </p>
              )}
              {run.results && (
                <p className="text-xs text-muted-foreground">
                  {format("reviews.applied", { applied: run.applied, skipped: run.skipped })}
                </p>
              )}
            </div>
            {run.engine !== "jev" && (
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy || !run.conversationId}
                  onClick={() => onOpen(run)}
                >
                  {label("reviews.openConversation")}
                </Button>
                {!run.results && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy || !run.conversationId}
                    onClick={() => onSync(run)}
                  >
                    {label("reviews.sync")}
                  </Button>
                )}
              </div>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}
