import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const root = mkdtempSync(path.join(tmpdir(), "openhorn-manual-"));
process.on("exit", () => rmSync(root, { recursive: true, force: true }));
process.env.NODE_ENV = "test";
process.env.DATABASE_URL = `file:${path.join(root, "tasks.db")}`;
const { Hono } = await import("hono");
const { bootstrapDatabase } = await import("../db/bootstrap");
const { client } = await import("../db");
await bootstrapDatabase({ backup: null });
await client.execute({
  sql: "INSERT INTO users(id,email,username,created_at,updated_at) VALUES(?,?,?,?,?)",
  args: ["synthetic-task-user", "task@example.invalid", "Synthetic", 1, 1],
});
const { createScheduledTask } = await import("../services/scheduledTaskService");
const localUserId = String((await client.execute("SELECT id FROM users LIMIT 1")).rows[0].id);
const task = await createScheduledTask(localUserId, {
  title: "Synthetic",
  prompt: "Never call a model",
  frequency: "daily",
  time: "09:00",
});
if (!task) throw new Error("Missing synthetic task");
const { default: routes } = await import("./scheduledTasks");
const app = new Hono().route("/scheduled-tasks", routes);
const manualResponse = await app.request(`/scheduled-tasks/${task.id}/run`, { method: "POST" });
const manual = (await manualResponse.json()) as { runId: string; conversationId: string };
const pendingResponse = await app.request("/scheduled-tasks/runs/pending");
const pending = (await pendingResponse.json()) as {
  runs: Array<{ id: string; status: string; ownerToken?: string }>;
};
const ownerToken = "synthetic-owner-000000001";
const send = (key: string) =>
  app.request(`/scheduled-tasks/${task.id}/manual-runs/${key}`, { method: "PUT" });
const count = async (table: string) =>
  Number((await client.execute(`SELECT count(*) n FROM ${table}`)).rows[0].n);
const snapshot = async () =>
  Promise.all(["conversations", "scheduled_task_runs", "manual_task_receipts"].map(count));
const before = await snapshot();
await client.execute(
  "CREATE TRIGGER fail_receipt BEFORE INSERT ON manual_task_receipts BEGIN SELECT RAISE(ABORT,'synthetic failure'); END",
);
const failed = await send("synthetic-manual-attempt");
await client.execute("DROP TRIGGER fail_receipt");
if (failed.status !== 500 || JSON.stringify(before) !== JSON.stringify(await snapshot()))
  throw new Error("partial manual enqueue");
const tries = await Promise.all([
  send("synthetic-manual-attempt"),
  send("synthetic-manual-attempt"),
]);
const readReceipt = async (r: Response) => (await r.json()) as typeof manual;
const receipts = await Promise.all(tries.map(readReceipt));
const second = await readReceipt(await send("synthetic-independent-click"));
if (
  !receipts[0].runId ||
  receipts[0].runId !== receipts[1].runId ||
  receipts[0].conversationId !== receipts[1].conversationId ||
  !second.runId ||
  second.runId === receipts[0].runId ||
  (await snapshot()).some((n, i) => n !== before[i] + 2)
)
  throw new Error("duplicate or missing run");
const json = (body: unknown) => ({
  method: "PATCH",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});
const noToken = await app.request(`/scheduled-tasks/runs/${manual.runId}/claim`, {
  method: "PATCH",
});
const claim = await app.request(
  `/scheduled-tasks/runs/${manual.runId}/claim`,
  json({ ownerToken }),
);
const other = await app.request(
  `/scheduled-tasks/runs/${manual.runId}/complete`,
  json({ ownerToken: "synthetic-owner-000000002", status: "completed" }),
);
const own = await app.request(
  `/scheduled-tasks/runs/${manual.runId}/complete`,
  json({ ownerToken, status: "completed", result: "Synthetic result" }),
);
const overwrite = await app.request(
  `/scheduled-tasks/runs/${manual.runId}/complete`,
  json({ ownerToken, status: "failed" }),
);
// Simulate the pre-lease table, then run the real additive migration twice.
for (const name of ["owner_token", "lease_expires_at", "error_code"]) {
  await client.execute(`ALTER TABLE scheduled_task_runs DROP COLUMN ${name}`);
}
await client.execute({
  sql: "INSERT INTO scheduled_task_runs(id,task_id,user_id,status,started_at) VALUES(?,?,?,?,?)",
  args: ["synthetic-legacy-run", task.id, localUserId, "running", Math.floor(Date.now() / 1000)],
});
await bootstrapDatabase({ backup: null });
await bootstrapDatabase({ backup: null });
const leaseColumns = (await client.execute("PRAGMA table_info('scheduled_task_runs')")).rows.map(
  (row) => String(row.name),
);
const legacy = (
  await client.execute("SELECT id,status FROM scheduled_task_runs WHERE id='synthetic-legacy-run'")
).rows[0];
console.log(
  JSON.stringify({
    leaseColumns,
    legacy,
    manualStatus: manualResponse.status,
    pending: pending.runs,
    noTokenStatus: noToken.status,
    claimed: await claim.json(),
    otherStatus: other.status,
    ownStatus: own.status,
    overwriteStatus: overwrite.status,
  }),
);
const { stopScheduler } = await import("../services/scheduledTaskScheduler");
stopScheduler();
client.close();
