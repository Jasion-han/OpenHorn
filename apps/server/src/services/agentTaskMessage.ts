/**
 * What a legacy task-backed (server-run) agent message shows, split by role:
 *
 * - the **reply text** — the full content of the task's final_result artifact,
 *   stored as the run's `text` step and therefore (through the shared
 *   `assistantMessageContent` rule) as the message `content`;
 * - the **failure** — the latest execution run's error, stored in
 *   `agentRun.error` and never in `content`.
 *
 * The server no longer creates such turns; these selectors are kept for the
 * one-time bootstrap backfill, which runs them over raw rows.
 */

type RunLike = { id: string; phase: string; error?: string | null };
type ArtifactLike = { runId: string; type: string; content: string };

/**
 * The final_result content that answers the task: the one produced by the
 * latest execution run, else the newest one overall. Same choice as the task
 * insight. `runs` and `artifacts` must be ordered newest first. Not clipped.
 */
export function selectTaskReplyText(runs: RunLike[], artifacts: ArtifactLike[]): string {
  const latestExecutionRun = runs.find((run) => run.phase === "execution") ?? null;
  const finalResult =
    (latestExecutionRun
      ? artifacts.find(
          (artifact) =>
            artifact.runId === latestExecutionRun.id && artifact.type === "final_result",
        )
      : undefined) ?? artifacts.find((artifact) => artifact.type === "final_result");
  return finalResult?.content?.trim() ?? "";
}

/** The error of a failed task (latest execution run's), or undefined. `runs` newest first. */
export function selectTaskFailure(taskStatus: string, runs: RunLike[]): string | undefined {
  if (taskStatus !== "failed") return undefined;
  const error = runs.find((run) => run.phase === "execution")?.error?.trim();
  return error || undefined;
}
