import type { InStatement, Row } from "@libsql/client";
import { client } from "./index";

/**
 * Task statuses a server-run (task-backed) agent turn could be left in. The
 * server used to plan such turns and stop at `draft` / `awaiting_approval`,
 * waiting for an execute / approve route that no longer exists — so none of
 * them can ever move again.
 */
const OPEN_TASK_STATUSES = ["draft", "planning", "awaiting_approval", "running"] as const;
const OPEN_RUN_STATUSES = ["pending", "running", "awaiting_approval"] as const;
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

function placeholders(values: readonly string[]): string {
  return values.map(() => "?").join(", ");
}

function rowsOf(result: { rows?: Row[] }): Row[] {
  return Array.isArray(result.rows) ? result.rows : [];
}

/**
 * One-time migration: settles every server-run agent turn that can no longer
 * progress.
 *
 * - open tasks → `cancelled`; their open runs → `cancelled`; pending approvals
 *   → `rejected`;
 * - each task-backed assistant message takes its task's final status as both
 *   `agentRun.status` and `agentRun.taskStatus`, so the bubble stops looking
 *   pending and the desktop renders it as a finished (cancelled) run. A message
 *   whose task is gone is only touched when it still claims to be in progress;
 * - conversations whose `run_status` names an open task status → NULL (no run
 *   in flight).
 *
 * Never touches message `content` or the run's steps: only status fields
 * change, so no reply text can be lost. All writes go in one transaction.
 * Idempotent. Returns the number of messages updated.
 */
export async function settleServerAgentTasks(): Promise<number> {
  const now = Math.floor(Date.now() / 1000);
  const statements: InStatement[] = [];

  const taskRows = rowsOf(await client.execute("SELECT id, status FROM agent_tasks;"));
  const settledStatus = new Map<string, string>();
  for (const row of taskRows) {
    const status = String(row.status);
    settledStatus.set(String(row.id), TERMINAL_STATUSES.has(status) ? status : "cancelled");
  }

  statements.push(
    {
      sql: `UPDATE agent_tasks SET status = 'cancelled', updated_at = ?
            WHERE status IN (${placeholders(OPEN_TASK_STATUSES)});`,
      args: [now, ...OPEN_TASK_STATUSES],
    },
    {
      sql: `UPDATE agent_runs SET status = 'cancelled', updated_at = ?
            WHERE status IN (${placeholders(OPEN_RUN_STATUSES)});`,
      args: [now, ...OPEN_RUN_STATUSES],
    },
    {
      sql: `UPDATE agent_approval_requests
            SET status = 'rejected', response = ?, responded_at = ?, updated_at = ?
            WHERE status = 'pending';`,
      args: [JSON.stringify({ source: "server_agent_removed" }), now, now],
    },
    {
      sql: `UPDATE conversations SET run_status = NULL
            WHERE run_status IN (${placeholders(OPEN_TASK_STATUSES)});`,
      args: [...OPEN_TASK_STATUSES],
    },
  );

  const messageRows = rowsOf(
    await client.execute(
      `SELECT id, agent_run FROM messages
       WHERE role = 'assistant' AND agent_run LIKE '%"taskId"%';`,
    ),
  );
  let changed = 0;
  for (const row of messageRows) {
    if (typeof row.agent_run !== "string") continue;
    let run: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(row.agent_run);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      run = parsed as Record<string, unknown>;
    } catch {
      continue;
    }
    if (typeof run.taskId !== "string" || !run.taskId) continue;

    let settled = settledStatus.get(run.taskId);
    if (!settled) {
      // Task no longer on record: leave a finished run alone, settle a pending one.
      if (TERMINAL_STATUSES.has(String(run.status))) continue;
      settled = "cancelled";
    }
    if (run.status === settled && run.taskStatus === settled) continue;

    statements.push({
      sql: "UPDATE messages SET agent_run = ? WHERE id = ?;",
      args: [JSON.stringify({ ...run, status: settled, taskStatus: settled }), String(row.id)],
    });
    changed++;
  }

  await client.batch(statements, "write");
  return changed;
}
