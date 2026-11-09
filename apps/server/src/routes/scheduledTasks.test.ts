import { expect, test } from "bun:test";

test("manual task routes enqueue real pending work and fence owner completion", () => {
  const child = Bun.spawnSync(
    [process.execPath, new URL("./scheduledTasks.fixture.ts", import.meta.url).pathname],
    {
      env: { ...process.env, NODE_ENV: "test", DATABASE_URL: "file::memory:" },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 15_000,
    },
  );
  expect(child.exitCode).toBe(0);
  const result = JSON.parse(child.stdout.toString());
  expect(result.manualStatus).toBe(200);
  expect(result.legacy).toEqual({ id: "synthetic-legacy-run", status: "running" });
  for (const name of ["owner_token", "lease_expires_at", "error_code"]) {
    expect(result.leaseColumns.filter((column: string) => column === name)).toHaveLength(1);
  }
  expect(result.pending).toHaveLength(1);
  expect(result.pending[0].status).toBe("pending");
  expect(result.pending[0].ownerToken).toBe(undefined);
  expect(result.noTokenStatus).toBe(400);
  expect(result.claimed.claimed).toBe(true);
  expect(result.otherStatus).toBe(409);
  expect(result.ownStatus).toBe(200);
  expect(result.overwriteStatus).toBe(409);
});
