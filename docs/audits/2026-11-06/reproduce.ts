import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const root = process.cwd();
process.env.NODE_ENV = "test";
process.env.DATABASE_URL = "file::memory:";
const { bootstrapDatabase } = await import(`${root}/apps/server/src/db/bootstrap.ts`);
const { client } = await import(`${root}/apps/server/src/db/index.ts`);
await bootstrapDatabase({ backup: null });
await client.execute({
  sql: "INSERT INTO users(id,email,username,created_at,updated_at) VALUES(?,?,?,?,?)",
  args: ["audit-user", "audit@example.invalid", "Synthetic audit", 1, 1],
});
const fakeConfig = JSON.stringify({
  command: "synthetic-command",
  env: { SERVICE_API_KEY: "AUDIT_FAKE_ENV_CREDENTIAL" },
  headers: { Authorization: "Bearer AUDIT_FAKE_HEADER_CREDENTIAL" },
});
await client.execute({
  sql: "INSERT INTO mcp_servers(id,user_id,name,type,config,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
  args: ["audit-mcp", "audit-user", "Synthetic MCP", "stdio", fakeConfig, 1, 1],
});
const { exportBackup } = await import(`${root}/apps/server/src/services/exportService.ts`);
const out = await mkdtemp(path.join(tmpdir(), "openhorn-audit-export-"));
try {
  await exportBackup("audit-user", out);
  console.log(JSON.stringify({ check: "backup-export", exported: true }));
} catch (error) {
  console.log(
    JSON.stringify({
      check: "backup-export",
      exported: false,
      error: error instanceof Error ? error.message : String(error),
    }),
  );
}
await client.execute({
  sql: "INSERT INTO scheduled_tasks(id,user_id,title,prompt,frequency,time,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
  args: ["audit-task", "audit-user", "Synthetic", "No execution", "daily", "09:00", 1, 1],
});
const { createTaskRun, claimTaskRun, finishTaskRun } = await import(
  `${root}/apps/server/src/services/scheduledTaskService.ts`
);
const id = await createTaskRun("audit-task", "audit-user", undefined, "pending");
const owner = "audit-owner-0000000001";
const otherOwner = "audit-owner-0000000002";
const claimed = await claimTaskRun("audit-user", id, owner);
const otherClientFinished = await finishTaskRun(
  "audit-user",
  id,
  {
    status: "failed",
    error: "synthetic second client reconciliation",
  },
  otherOwner,
);
const row = (
  await client.execute({ sql: "SELECT status FROM scheduled_task_runs WHERE id=?", args: [id] })
).rows[0];
const lateOwnerFinished = await finishTaskRun(
  "audit-user",
  id,
  {
    status: "completed",
    result: "synthetic late owner",
  },
  owner,
);
const terminalRewrite = await finishTaskRun("audit-user", id, { status: "failed" }, owner);
console.log(
  JSON.stringify({
    check: "run-ownership",
    claimed,
    otherClientFinished,
    statusAfterOtherClient: row?.status,
    lateOwnerFinished,
    terminalRewrite,
  }),
);
client.close();
await rm(out, { recursive: true, force: true });

const breaker = await import(`${root}/apps/server/src/services/circuitBreaker.ts`);
const realNow = Date.now;
let now = 1000000;
Date.now = () => now;
try {
  breaker.resetAllBreakers();
  for (let i = 0; i < 5; i++) breaker.recordChannelFailure("audit");
  const openAllowed = breaker.isChannelAvailable("audit");
  now += 30001;
  const probes = [
    breaker.isChannelAvailable("audit"),
    breaker.isChannelAvailable("audit"),
    breaker.isChannelAvailable("audit"),
  ];
  console.log(
    JSON.stringify({
      check: "breaker",
      openAllowed,
      state: breaker.getChannelBreakerState("audit"),
      probes,
    }),
  );
} finally {
  Date.now = realNow;
  breaker.resetAllBreakers();
}
